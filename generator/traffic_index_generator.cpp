#include "generator/traffic_index_generator.hpp"

#include "traffic/traffic_info.hpp"

#include "routing_common/car_model.hpp"

#include "indexer/feature.hpp"
#include "indexer/feature_data.hpp"
#include "indexer/feature_processor.hpp"
#include "indexer/ftypes_matcher.hpp"

#include "geometry/mercator.hpp"

#include "coding/file_writer.hpp"

#include "base/logging.hpp"
#include "base/math.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace traffic
{
namespace
{
uint16_t constexpr kFormatVersion = 1;
size_t constexpr kHeaderBytes = 56;
size_t constexpr kSegmentRecordBytes = 16;

// One record per directional segment, in the same order as the expanded key list, so the
// service can write speed groups straight into a values array by index.
struct SegmentRecord
{
  uint32_t m_segmentIndex = 0;
  int32_t m_latE7 = 0;
  int32_t m_lonE7 = 0;
  uint16_t m_bearingDeg = 0;
  uint8_t m_roadClass = 0;
  uint32_t m_cell = 0;
};

int32_t ToE7(double deg)
{
  return static_cast<int32_t>(std::lround(deg * 1e7));
}

// Initial bearing in degrees clockwise from north, matching the service's bearingDegrees().
uint16_t BearingDeg(ms::LatLon const & a, ms::LatLon const & b)
{
  double const lat1 = math::DegToRad(a.m_lat);
  double const lat2 = math::DegToRad(b.m_lat);
  double const dLon = math::DegToRad(b.m_lon - a.m_lon);
  double const y = std::sin(dLon) * std::cos(lat2);
  double const x = std::cos(lat1) * std::sin(lat2) - std::sin(lat1) * std::cos(lat2) * std::cos(dLon);
  double deg = math::RadToDeg(std::atan2(y, x));
  if (deg < 0.0)
    deg += 360.0;
  return static_cast<uint16_t>(std::lround(deg)) % 360;
}

uint8_t RoadClassCode(ftypes::HighwayClass cls)
{
  switch (cls)
  {
  case ftypes::HighwayClass::Motorway: return 0;
  case ftypes::HighwayClass::Trunk: return 1;
  case ftypes::HighwayClass::Primary: return 2;
  case ftypes::HighwayClass::Secondary: return 3;
  case ftypes::HighwayClass::Tertiary: return 4;
  default: return 5;
  }
}

void WriteU16(std::vector<uint8_t> & out, size_t offset, uint16_t v)
{
  out[offset] = static_cast<uint8_t>(v & 0xff);
  out[offset + 1] = static_cast<uint8_t>((v >> 8) & 0xff);
}

void WriteU32(std::vector<uint8_t> & out, size_t offset, uint32_t v)
{
  for (size_t i = 0; i < 4; ++i)
    out[offset + i] = static_cast<uint8_t>((v >> (8 * i)) & 0xff);
}

void WriteU64(std::vector<uint8_t> & out, size_t offset, uint64_t v)
{
  for (size_t i = 0; i < 8; ++i)
    out[offset + i] = static_cast<uint8_t>((v >> (8 * i)) & 0xff);
}

void AppendU32(std::vector<uint8_t> & out, uint32_t v)
{
  for (size_t i = 0; i < 4; ++i)
    out.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
}

void PadTo4(std::vector<uint8_t> & out)
{
  while (out.size() % 4 != 0)
    out.push_back(0);
}
}  // namespace

bool GenerateTrafficIndex(std::string const & mwmPath, std::string const & outPath, std::string const & countryName,
                          uint64_t mwmVersion, TrafficIndexParams const & params)
{
  auto const & carModel = routing::CarModel::AllLimitsInstance();
  ftypes::IsOneWayChecker const & oneWayChecker = ftypes::IsOneWayChecker::Instance();

  std::vector<TrafficInfo::RoadSegmentId> keys;
  std::vector<SegmentRecord> records;

  double minLat = 90.0, minLon = 180.0, maxLat = -90.0, maxLon = -180.0;
  size_t oneWayDisagreements = 0;
  bool overflow = false;

  try
  {
    feature::ForEachFeature(mwmPath, [&](FeatureType & ft, uint32_t const fid)
    {
      if (overflow)
        return;

      feature::TypesHolder const types(ft);
      if (!carModel.IsRoad(types))
        return;

      auto const hwClass = ftypes::GetHighwayClass(types);
      if (params.m_roadClasses.count(hwClass) == 0)
        return;

      ft.ParseGeometry(FeatureType::BEST_GEOMETRY);
      auto const numPoints = static_cast<uint16_t>(ft.GetPointsCount());
      if (numPoints < 2)
        return;

      // The extractor's notion of one-way must agree with the renderer's, or the feature's
      // direction count will not match the geometry the client draws and it will never colour.
      bool const carOneWay = carModel.IsOneWay(types);
      if (carOneWay != oneWayChecker(types))
        ++oneWayDisagreements;

      uint8_t const numDirs = carOneWay ? 1 : 2;

      // Keep whole features: the keys format stores a segment count and a one-way flag per
      // feature, so a feature is either wholly in or wholly out. Include it if any part of it
      // falls inside the requested area.
      bool inside = false;
      for (uint16_t i = 0; i < numPoints && !inside; ++i)
      {
        auto const ll = mercator::ToLatLon(ft.GetPoint(i));
        inside = ll.m_lat >= params.m_minLat && ll.m_lat <= params.m_maxLat && ll.m_lon >= params.m_minLon &&
                 ll.m_lon <= params.m_maxLon;
      }
      if (!inside)
        return;

      if (keys.size() + static_cast<size_t>(numPoints - 1) * numDirs > params.m_maxSegments)
      {
        overflow = true;
        return;
      }

      for (uint16_t i = 0; i + 1 < numPoints; ++i)
      {
        auto const a = mercator::ToLatLon(ft.GetPoint(i));
        auto const b = mercator::ToLatLon(ft.GetPoint(i + 1));
        double const midLat = (a.m_lat + b.m_lat) / 2.0;
        double const midLon = (a.m_lon + b.m_lon) / 2.0;
        uint16_t const bearing = BearingDeg(a, b);

        minLat = std::min(minLat, midLat);
        maxLat = std::max(maxLat, midLat);
        minLon = std::min(minLon, midLon);
        maxLon = std::max(maxLon, midLon);

        for (uint8_t dir = 0; dir < numDirs; ++dir)
        {
          SegmentRecord rec;
          rec.m_segmentIndex = static_cast<uint32_t>(keys.size());
          rec.m_latE7 = ToE7(midLat);
          rec.m_lonE7 = ToE7(midLon);
          rec.m_bearingDeg = bearing;
          rec.m_roadClass = RoadClassCode(hwClass);
          records.push_back(rec);

          keys.emplace_back(fid, i, dir);
        }
      }
    });
  }
  catch (RootException const & e)
  {
    LOG(LERROR, ("Failed to read", mwmPath, ":", e.Msg()));
    return false;
  }

  if (overflow)
  {
    LOG(LERROR, ("Area exceeds the", params.m_maxSegments,
                 "segment limit. Coverage is meant to be a city or a corridor, not a whole country."
                 " Narrow --traffic_index_bbox, or drop road classes with --traffic_index_road_classes."));
    return false;
  }

  if (keys.empty())
  {
    LOG(LERROR, ("No matching road segments in", mwmPath, "for the requested area."));
    return false;
  }

  if (oneWayDisagreements > 0)
  {
    LOG(LWARNING, ("CarModel and IsOneWayChecker disagree on", oneWayDisagreements,
                   "features; those roads may not colour correctly."));
  }

  // Serialised by the client's own encoder, so the blob is by construction exactly what its
  // decoder expects.
  std::vector<uint8_t> keysBlob;
  TrafficInfo::SerializeTrafficKeys(keys, keysBlob);

  // Prove it before writing anything: a bad keys blob shows up on-device as traffic that
  // silently never appears.
  {
    std::vector<TrafficInfo::RoadSegmentId> roundTripped;
    try
    {
      TrafficInfo::DeserializeTrafficKeys(keysBlob, roundTripped);
    }
    catch (RootException const & e)
    {
      LOG(LERROR, ("Serialized traffic keys did not parse back:", e.Msg()));
      return false;
    }
    if (roundTripped != keys)
    {
      LOG(LERROR, ("Serialized traffic keys did not round-trip; refusing to write a broken index."));
      return false;
    }
  }

  // Bucket segments into a uniform grid so the service can match incidents without scanning.
  uint32_t const cols = std::max<uint32_t>(1, params.m_gridCols);
  uint32_t const rows = std::max<uint32_t>(1, params.m_gridRows);
  double const latSpan = std::max(1e-9, maxLat - minLat);
  double const lonSpan = std::max(1e-9, maxLon - minLon);

  for (auto & rec : records)
  {
    double const lat = rec.m_latE7 / 1e7;
    double const lon = rec.m_lonE7 / 1e7;
    auto const col = std::min<uint32_t>(cols - 1, static_cast<uint32_t>((lon - minLon) / lonSpan * cols));
    auto const row = std::min<uint32_t>(rows - 1, static_cast<uint32_t>((lat - minLat) / latSpan * rows));
    rec.m_cell = row * cols + col;
  }
  std::stable_sort(records.begin(), records.end(),
                   [](SegmentRecord const & a, SegmentRecord const & b) { return a.m_cell < b.m_cell; });

  uint32_t const numCells = cols * rows;
  std::vector<uint32_t> cellOffsets(numCells + 1, 0);
  for (auto const & rec : records)
    ++cellOffsets[rec.m_cell + 1];
  for (uint32_t i = 0; i < numCells; ++i)
    cellOffsets[i + 1] += cellOffsets[i];

  // See tools/traffic_server/src/core/index/format.ts for the authoritative layout.
  std::vector<uint8_t> out(kHeaderBytes, 0);
  std::memcpy(out.data(), "CMTI", 4);
  WriteU16(out, 4, kFormatVersion);
  WriteU16(out, 6, 0);
  WriteU64(out, 8, mwmVersion);
  WriteU32(out, 16, static_cast<uint32_t>(ToE7(minLat)));
  WriteU32(out, 20, static_cast<uint32_t>(ToE7(minLon)));
  WriteU32(out, 24, static_cast<uint32_t>(ToE7(maxLat)));
  WriteU32(out, 28, static_cast<uint32_t>(ToE7(maxLon)));
  WriteU32(out, 32, cols);
  WriteU32(out, 36, rows);
  WriteU32(out, 40, static_cast<uint32_t>(records.size()));
  WriteU32(out, 44, static_cast<uint32_t>(countryName.size()));
  WriteU32(out, 48, static_cast<uint32_t>(keysBlob.size()));
  WriteU32(out, 52, 0);

  out.insert(out.end(), countryName.begin(), countryName.end());
  PadTo4(out);
  out.insert(out.end(), keysBlob.begin(), keysBlob.end());
  PadTo4(out);

  for (auto const offset : cellOffsets)
    AppendU32(out, offset);

  for (auto const & rec : records)
  {
    AppendU32(out, rec.m_segmentIndex);
    AppendU32(out, static_cast<uint32_t>(rec.m_latE7));
    AppendU32(out, static_cast<uint32_t>(rec.m_lonE7));
    out.push_back(static_cast<uint8_t>(rec.m_bearingDeg & 0xff));
    out.push_back(static_cast<uint8_t>((rec.m_bearingDeg >> 8) & 0xff));
    out.push_back(rec.m_roadClass);
    out.push_back(0);
  }

  try
  {
    FileWriter writer(outPath);
    writer.Write(out.data(), out.size());
  }
  catch (FileWriter::Exception const & e)
  {
    LOG(LERROR, ("Could not write", outPath, ":", e.Msg()));
    return false;
  }

  LOG(LINFO, ("Wrote", outPath, "-", records.size(), "segments,", keysBlob.size(), "bytes of keys,",
              out.size(), "bytes total. Configure it as", countryName + "@" + std::to_string(mwmVersion)));
  return true;
}
}  // namespace traffic
