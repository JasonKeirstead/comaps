package app.organicmaps.traffic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class TrafficPairingTest
{
  @Test
  public void parsesAScannedPairingCode()
  {
    final TrafficPairing.PairingRequest request =
        TrafficPairing.parse("comaps://traffic/pair?u=http%3A%2F%2F192.168.1.50%3A8080%2F&t=K7Q2M4XR9TVB3NHW");

    assertNotNull(request);
    assertEquals("http://192.168.1.50:8080/", request.baseUrl);
    assertEquals("K7Q2M4XR9TVB3NHW", request.token);
  }

  @Test
  public void addsTheTrailingSlashTheClientDependsOn()
  {
    // MakeRemoteURL appends "{version}/{country}.traffic" straight onto the base.
    final TrafficPairing.PairingRequest request =
        TrafficPairing.parse("comaps://traffic/pair?u=https%3A%2F%2Ftraffic.example.com%2Fapi&t=ABCD1234");

    assertNotNull(request);
    assertEquals("https://traffic.example.com/api/", request.baseUrl);
  }

  @Test
  public void ignoresBarcodesThatAreNotPairingCodes()
  {
    assertNull(TrafficPairing.parse(null));
    assertNull(TrafficPairing.parse(""));
    assertNull(TrafficPairing.parse("https://example.com"));
    assertNull(TrafficPairing.parse("comaps://map?ll=53.9,27.5"));
  }

  @Test
  public void rejectsIncompleteOrUnusableCodes()
  {
    assertNull(TrafficPairing.parse("comaps://traffic/pair?t=ABCD1234"));
    assertNull(TrafficPairing.parse("comaps://traffic/pair?u=http%3A%2F%2Fhost%2F"));
    assertNull(TrafficPairing.parse("comaps://traffic/pair?u=http%3A%2F%2Fhost%2F&t="));
    // A scheme we would not know how to fetch.
    assertNull(TrafficPairing.parse("comaps://traffic/pair?u=ftp%3A%2F%2Fhost%2F&t=ABCD1234"));
    assertNull(TrafficPairing.parse("comaps://traffic/pair?u=notaurl&t=ABCD1234"));
  }

  @Test
  public void normalizesUrlsTypedByHand()
  {
    assertEquals("http://192.168.1.50:8080/", TrafficPairing.normalizeUrl("  http://192.168.1.50:8080  "));
    assertEquals("https://host/x/", TrafficPairing.normalizeUrl("https://host/x/"));
    assertNull(TrafficPairing.normalizeUrl(""));
    assertNull(TrafficPairing.normalizeUrl("host:8080"));
    assertNull(TrafficPairing.normalizeUrl("http://"));
  }

  @Test
  public void readsThePairingResponse() throws Exception
  {
    final TrafficPairing.PairingResult result = TrafficPairing.parseResponse(
        "http://scanned/", "{\"apiKey\":\"KEY123\",\"baseUrl\":\"http://public.example\",\"serverName\":\"Home\"}");

    assertEquals("KEY123", result.apiKey);
    // The server's own idea of its address wins, since it may sit behind a proxy.
    assertEquals("http://public.example/", result.baseUrl);
    assertEquals("Home", result.serverName);
  }

  @Test
  public void fallsBackToTheScannedUrlWhenTheServerOmitsOne() throws Exception
  {
    final TrafficPairing.PairingResult result =
        TrafficPairing.parseResponse("http://scanned/", "{\"apiKey\":\"KEY123\"}");

    assertEquals("http://scanned/", result.baseUrl);
  }

  @Test
  public void aResponseWithoutAKeyIsAnError()
  {
    assertThrows(TrafficPairing.PairingException.class,
                 () -> TrafficPairing.parseResponse("http://scanned/", "{\"serverName\":\"Home\"}"));
  }
}
