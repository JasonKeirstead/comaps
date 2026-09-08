package app.organicmaps.traffic;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pairing with a self-hosted traffic service.
 * <p>
 * Deliberately free of Android UI types so the parsing and validation can be unit tested without
 * Robolectric. The scanner activity supplies the scanned text and shows the result.
 * <p>
 * The QR carries a short-lived, single-use token rather than the API key itself, so a code can be
 * displayed on a screen without exposing a long-lived secret:
 * <pre>comaps://traffic/pair?u=&lt;url-encoded base&gt;&amp;t=&lt;token&gt;</pre>
 */
public final class TrafficPairing
{
  public static final String SCHEME = "comaps";
  private static final String PAIR_PREFIX = "comaps://traffic/pair?";
  private static final int TIMEOUT_MS = 15000;

  /** What a scanned QR code decodes to. */
  public static final class PairingRequest
  {
    @NonNull
    public final String baseUrl;
    @NonNull
    public final String token;

    PairingRequest(@NonNull String baseUrl, @NonNull String token)
    {
      this.baseUrl = baseUrl;
      this.token = token;
    }
  }

  /** What the server hands back once the token is redeemed. */
  public static final class PairingResult
  {
    @NonNull
    public final String baseUrl;
    @NonNull
    public final String apiKey;
    @NonNull
    public final String serverName;

    PairingResult(@NonNull String baseUrl, @NonNull String apiKey, @NonNull String serverName)
    {
      this.baseUrl = baseUrl;
      this.apiKey = apiKey;
      this.serverName = serverName;
    }
  }

  public static final class PairingException extends Exception
  {
    public PairingException(@NonNull String message)
    {
      super(message);
    }

    public PairingException(@NonNull String message, @NonNull Throwable cause)
    {
      super(message, cause);
    }
  }

  private TrafficPairing() {}

  /**
   * Parses a scanned QR payload. Returns null when the text is not a CoMaps pairing code at all,
   * so the scanner can keep scanning rather than showing an error for every stray barcode.
   */
  @Nullable
  public static PairingRequest parse(@Nullable String scanned)
  {
    if (scanned == null)
      return null;

    final String text = scanned.trim();
    if (!text.startsWith(PAIR_PREFIX))
      return null;

    String baseUrl = null;
    String token = null;
    for (final String pair : text.substring(PAIR_PREFIX.length()).split("&"))
    {
      final int eq = pair.indexOf('=');
      if (eq <= 0)
        continue;
      final String name = pair.substring(0, eq);
      final String value = decode(pair.substring(eq + 1));
      if ("u".equals(name))
        baseUrl = value;
      else if ("t".equals(name))
        token = value;
    }

    if (baseUrl == null || token == null || token.isEmpty())
      return null;

    final String normalized = normalizeUrl(baseUrl);
    return normalized == null ? null : new PairingRequest(normalized, token);
  }

  /**
   * Trims, requires an http(s) scheme and a host, and guarantees a trailing slash. The client
   * appends "{version}/{country}.traffic" directly to this, so a missing slash silently produces
   * requests to the wrong path.
   */
  @Nullable
  public static String normalizeUrl(@Nullable String raw)
  {
    if (raw == null)
      return null;

    String url = raw.trim();
    if (url.isEmpty())
      return null;
    if (!url.startsWith("http://") && !url.startsWith("https://"))
      return null;

    try
    {
      if (new URL(url).getHost().isEmpty())
        return null;
    }
    catch (java.net.MalformedURLException e)
    {
      return null;
    }

    if (!url.endsWith("/"))
      url = url + "/";
    return url;
  }

  /** Redeems a pairing token. Blocking; call it off the main thread. */
  @NonNull
  public static PairingResult redeem(@NonNull PairingRequest request, @NonNull String deviceName)
      throws PairingException
  {
    HttpURLConnection connection = null;
    try
    {
      final JSONObject body = new JSONObject();
      body.put("token", request.token);
      body.put("device", deviceName);

      connection = (HttpURLConnection) new URL(request.baseUrl + "v1/pair").openConnection();
      connection.setRequestMethod("POST");
      connection.setConnectTimeout(TIMEOUT_MS);
      connection.setReadTimeout(TIMEOUT_MS);
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");

      try (OutputStream out = connection.getOutputStream())
      {
        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }

      final int status = connection.getResponseCode();
      final String response = readAll(status >= 400 ? connection.getErrorStream() : connection.getInputStream());

      if (status != 200)
        throw new PairingException(errorMessage(status, response));

      return parseResponse(request.baseUrl, response);
    }
    catch (IOException e)
    {
      throw new PairingException("Could not reach the traffic server: " + e.getMessage(), e);
    }
    catch (JSONException e)
    {
      throw new PairingException("The traffic server sent an unexpected response.", e);
    }
    finally
    {
      if (connection != null)
        connection.disconnect();
    }
  }

  /** Split out so the response shape is testable without a network. */
  @NonNull
  static PairingResult parseResponse(@NonNull String fallbackBaseUrl, @NonNull String json) throws JSONException,
                                                                                                   PairingException
  {
    final JSONObject object = new JSONObject(json);
    final String apiKey = object.optString("apiKey", "");
    if (apiKey.isEmpty())
      throw new PairingException("The traffic server did not return an API key.");

    // The server knows the address clients should use, which may differ from the one on the QR
    // (for instance when it sits behind a reverse proxy). Fall back to what we scanned.
    String baseUrl = normalizeUrl(object.optString("baseUrl", ""));
    if (baseUrl == null)
      baseUrl = fallbackBaseUrl;

    return new PairingResult(baseUrl, apiKey, object.optString("serverName", ""));
  }

  @NonNull
  private static String errorMessage(int status, @NonNull String response)
  {
    String detail = "";
    try
    {
      detail = new JSONObject(response).optString("error", "");
    }
    catch (JSONException ignored)
    {
      // Fall through to the generic message below.
    }

    if (!detail.isEmpty())
      return detail;
    if (status == 410 || status == 409)
      return "That pairing code has expired or was already used. Generate a new one.";
    if (status == 404)
      return "That pairing code was not recognised.";
    return "The traffic server refused the pairing (HTTP " + status + ").";
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

  @NonNull
  private static String decode(@NonNull String value)
  {
    try
    {
      return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
    }
    catch (java.io.UnsupportedEncodingException e)
    {
      return value;
    }
  }
}
