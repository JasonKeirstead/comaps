package app.organicmaps.sdk.traffic;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Builds a traffic index from a map already downloaded on this device.
 * <p>
 * A traffic index is per (country, map version), not per device: feature ids are positional
 * within a map release, so an index built for one release does not line up with another. Building
 * it here rather than on a desktop means it always matches what is actually installed, including
 * straight after a map update.
 * <p>
 * The result is a {@code .cmti} blob that gets uploaded to the user's own traffic service.
 */
public final class TrafficIndex
{
  /**
   * Default cap on directional road segments. Matches the generator's own limit: coverage is
   * meant to be a city or a corridor, and a whole country would be useless in practice because
   * the client holds the whole key list in memory.
   */
  public static final int DEFAULT_MAX_SEGMENTS = 250000;

  private TrafficIndex() {}

  /**
   * Builds an index for a downloaded map, restricted to a bounding box.
   *
   * @param countryId the map id as used by the downloader, e.g. "Belarus_Minsk Region"
   * @return the .cmti bytes, or null if the map is not downloaded or the area is too large
   */
  @Nullable
  public static byte[] build(@NonNull String countryId, double minLat, double minLon, double maxLat, double maxLon,
                             int maxSegments)
  {
    return nativeBuild(countryId, minLat, minLon, maxLat, maxLon, maxSegments);
  }

  /** The map version the given country is installed at, or 0 when it is not downloaded. */
  public static long mapVersion(@NonNull String countryId)
  {
    return nativeMapVersion(countryId);
  }

  private static native byte[] nativeBuild(String countryId, double minLat, double minLon, double maxLat,
                                           double maxLon, int maxSegments);

  private static native long nativeMapVersion(String countryId);
}
