/**
 * The "CMTI" traffic index: the offline artifact produced by
 * `generator_tool --generate_traffic_index` and consumed by this service.
 *
 * It exists because deriving traffic keys means parsing an MWM (feature geometry plus the car
 * model's road classification), which is not something to reimplement in TypeScript and is
 * impossible on Cloudflare Workers. So the MWM is read once, offline, and the runtime only ever
 * sees this.
 *
 * It carries two things:
 *   - the `.traffic.keys` blob, served to clients verbatim;
 *   - a segment table with a representative point per segment, bucketed into a uniform grid so
 *     incident geometry can be matched to segments without scanning.
 *
 * Segment record i corresponds to key i in the expanded key order, which is what lets the
 * refresh job write speed groups straight into a values array by index.
 *
 * All integers are little-endian. Coordinates are degrees x 1e7.
 *
 * Layout:
 *   0   char[4]  magic "CMTI"
 *   4   u16      formatVersion (1)
 *   6   u16      flags (reserved, 0)
 *   8   u64      mwmVersion (map series stamp, e.g. 250628)
 *   16  i32[4]   bbox: minLat, minLon, maxLat, maxLon (x1e7)
 *   32  u32      gridCols
 *   36  u32      gridRows
 *   40  u32      segmentCount N
 *   44  u32      countryNameLen
 *   48  u32      keysLen
 *   52  u32      reserved (0)
 *   56  u8[]     countryName (UTF-8), padded to a 4-byte boundary
 *       u8[]     keys blob,           padded to a 4-byte boundary
 *       u32[]    cellOffsets, length gridCols*gridRows + 1 (CSR into the segment table)
 *       rec[N]   segments, 16 bytes each, ordered by cell:
 *                  u32 segmentIndex   index into the expanded key list
 *                  i32 latE7, lonE7   segment midpoint
 *                  u16 bearingDeg     0..359, direction of travel for dir=0
 *                  u8  roadClass      0 = motorway .. 4 = tertiary
 *                  u8  reserved
 */

export const CMTI_MAGIC = 0x49544d43; // "CMTI" read as a LE u32
export const CMTI_FORMAT_VERSION = 1;
export const SEGMENT_RECORD_BYTES = 16;
export const HEADER_BYTES = 56;

export interface TrafficIndex {
  mwmVersion: number;
  countryName: string;
  /** Served verbatim as the `.traffic.keys` body. */
  keysBlob: Uint8Array;
  /** Number of expanded keys; the values array must be exactly this long. */
  segmentCount: number;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  gridCols: number;
  gridRows: number;
  cellOffsets: Uint32Array;
  /** N records of SEGMENT_RECORD_BYTES, ordered by grid cell. */
  segments: DataView;
}

export interface SegmentRecord {
  segmentIndex: number;
  lat: number;
  lon: number;
  bearingDeg: number;
  roadClass: number;
}

const align4 = (n: number) => (n + 3) & ~3;

export function parseTrafficIndex(buf: ArrayBuffer): TrafficIndex {
  if (buf.byteLength < HEADER_BYTES) throw new Error('traffic index truncated');
  const dv = new DataView(buf);

  if (dv.getUint32(0, true) !== CMTI_MAGIC) throw new Error('not a CMTI traffic index');
  const formatVersion = dv.getUint16(4, true);
  if (formatVersion !== CMTI_FORMAT_VERSION) {
    throw new Error(`unsupported traffic index version ${formatVersion}; rebuild the index`);
  }

  const mwmVersion = Number(dv.getBigUint64(8, true));
  const bbox = {
    minLat: dv.getInt32(16, true) / 1e7,
    minLon: dv.getInt32(20, true) / 1e7,
    maxLat: dv.getInt32(24, true) / 1e7,
    maxLon: dv.getInt32(28, true) / 1e7,
  };
  const gridCols = dv.getUint32(32, true);
  const gridRows = dv.getUint32(36, true);
  const segmentCount = dv.getUint32(40, true);
  const countryNameLen = dv.getUint32(44, true);
  const keysLen = dv.getUint32(48, true);

  let off = HEADER_BYTES;
  const countryName = new TextDecoder().decode(new Uint8Array(buf, off, countryNameLen));
  off = align4(off + countryNameLen);

  const keysBlob = new Uint8Array(buf.slice(off, off + keysLen));
  off = align4(off + keysLen);

  const numCells = gridCols * gridRows;
  const cellOffsets = new Uint32Array(buf.slice(off, off + (numCells + 1) * 4));
  off += (numCells + 1) * 4;

  const segmentsBytes = segmentCount * SEGMENT_RECORD_BYTES;
  if (off + segmentsBytes > buf.byteLength) throw new Error('traffic index segment table truncated');
  const segments = new DataView(buf, off, segmentsBytes);

  if (cellOffsets[numCells] !== segmentCount) {
    throw new Error(`traffic index grid covers ${cellOffsets[numCells]} segments, expected ${segmentCount}`);
  }

  return { mwmVersion, countryName, keysBlob, segmentCount, bbox, gridCols, gridRows, cellOffsets, segments };
}

export function readSegment(index: TrafficIndex, i: number): SegmentRecord {
  const o = i * SEGMENT_RECORD_BYTES;
  return {
    segmentIndex: index.segments.getUint32(o, true),
    lat: index.segments.getInt32(o + 4, true) / 1e7,
    lon: index.segments.getInt32(o + 8, true) / 1e7,
    bearingDeg: index.segments.getUint16(o + 12, true),
    roadClass: index.segments.getUint8(o + 14),
  };
}
