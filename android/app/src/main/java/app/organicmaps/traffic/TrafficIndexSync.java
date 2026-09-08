package app.organicmaps.traffic;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Keeps the user's traffic service supplied with indexes for the maps on this device.
 * <p>
 * A traffic index is per (country, map version), never per device: feature ids are positional
 * within a map release. So the set of indexes a server needs is exactly the set of maps its
 * clients have, and it changes whenever a map is downloaded or updated. Building here and
 * uploading keeps the two in step without a desktop toolchain or any manual step.
 * <p>
 * The upload is authenticated with the pairing key the app already holds, so no cloud credential
 * ever lives on the phone -- the app only ever talks to the user's own server.
 * <p>
 * Free of Android UI types so the decision logic can be unit tested.
 */
public final class TrafficIndexSync
{
  private static final int TIMEOUT_MS = 60000;

  /** Outcome of trying to supply one map's index. */
  public enum Result
  {
    /** The server did not have it and now does. */
    UPLOADED,
    /** The server already had an index for this map and version. */
    ALREADY_PRESENT,
    /** The map is not downloaded on this device. */
    NOT_DOWNLOADED,
    /** The area is larger than the generator will build. */
    TOO_LARGE,
    /** The server rejected it or could not be reached. */
    FAILED
  }

  public static final class Outcome
  {
    @NonNull
    public final Result result;
    @Nullable
    public final String detail;

    Outcome(@NonNull Result result, @Nullable String detail)
    {
      this.result = result;
      this.detail = detail;
    }
  }

  private TrafficIndexSync() {}

  /**
   * Builds an index for one downloaded map and uploads it. Blocking; call off the main thread.
   *
   * @param countryId map id as used by the downloader, e.g. "Belarus_Minsk Region"
   */
  @NonNull
  public static Outcome sync(@NonNull String baseUrl, @NonNull String apiKey, @NonNull String countryId,
                             double minLat, double minLon, double maxLat, double maxLon)
  {
    final long mapVersion = TrafficIndex.mapVersion(countryId);
    if (mapVersion <= 0)
      return new Outcome(Result.NOT_DOWNLOADED, countryId + " is not downloaded");

    final byte[] index =
        TrafficIndex.build(countryId, minLat, minLon, maxLat, maxLon, TrafficIndex.DEFAULT_MAX_SEGMENTS);
    if (index == null)
    {
      // The generator refuses areas above its segment cap, which is the usual reason to get here.
      return new Outcome(Result.TOO_LARGE, "Could not build an index for " + countryId
          + ". Try a smaller area.");
    }

    return upload(baseUrl, apiKey, countryId, mapVersion, index);
  }

  @NonNull
  static Outcome upload(@NonNull String baseUrl, @NonNull String apiKey, @NonNull String countryId, long mapVersion,
                        @NonNull byte[] index)
  {
    HttpURLConnection connection = null;
    try
    {
      connection = (HttpURLConnection) new URL(baseUrl + "v1/index").openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(TIMEOUT_MS);
      connection.setReadTimeout(TIMEOUT_MS);
      connection.setDoOutput(true);
      connection.setFixedLengthStreamingMode(index.length);
      connection.setRequestProperty("Content-Type", "application/octet-stream");
      connection.setRequestProperty("x-api-key", apiKey);
      connection.setRequestProperty("x-traffic-country", countryId);
      connection.setRequestProperty("x-traffic-map-version", Long.toString(mapVersion));

      try (OutputStream out = connection.getOutputStream())
      {
        out.write(index);
      }

      final int status = connection.getResponseCode();
      final String response = readAll(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
      return interpret(status, response);
    }
    catch (IOException e)
    {
      return new Outcome(Result.FAILED, "Could not reach the traffic server: " + e.getMessage());
    }
    finally
    {
      if (connection != null)
        connection.disconnect();
    }
  }

  /** Split out so the response handling is testable without a network. */
  @NonNull
  static Outcome interpret(int status, @NonNull String response)
  {
    if (status == 200)
    {
      String state = "";
      try
      {
        state = new JSONObject(response).optString("status", "");
      }
      catch (JSONException ignored)
      {
        // Treat an unparseable 200 as success; the server stored it either way.
      }
      return "already-present".equals(state) ? new Outcome(Result.ALREADY_PRESENT, null)
                                             : new Outcome(Result.UPLOADED, null);
    }

    String detail = "";
    try
    {
      detail = new JSONObject(response).optString("error", "");
    }
    catch (JSONException ignored)
    {
      // Fall through to the status-based message.
    }

    if (detail.isEmpty())
    {
      detail = status == 401 ? "This device is not paired with the traffic server."
                             : "The traffic server rejected the index (HTTP " + status + ").";
    }
    return new Outcome(Result.FAILED, detail);
  }

  @NonNull
  private static String readAll(@Nullable InputStream stream) throws IOException
  {
    if (stream == null)
      return "";

    final StringBuilder builder = new StringBuilder();
    final byte[] buffer = new byte[4096];
    int read;
    while ((read = stream.read(buffer)) != -1)
      builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
    return builder.toString();
  }
}
