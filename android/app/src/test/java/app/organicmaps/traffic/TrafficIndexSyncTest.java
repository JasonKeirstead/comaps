package app.organicmaps.traffic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TrafficIndexSyncTest
{
  @Test
  public void aStoredIndexCountsAsUploaded()
  {
    final TrafficIndexSync.Outcome outcome =
        TrafficIndexSync.interpret(200, "{\"status\":\"stored\",\"segments\":22226}");

    assertEquals(TrafficIndexSync.Result.UPLOADED, outcome.result);
    assertNull(outcome.detail);
  }

  @Test
  public void anIndexTheServerAlreadyHasIsNotAnError()
  {
    // Indexes are per (country, map version) and identical for every device on that map build,
    // so re-uploading one is expected and must not look like a failure.
    final TrafficIndexSync.Outcome outcome =
        TrafficIndexSync.interpret(200, "{\"status\":\"already-present\"}");

    assertEquals(TrafficIndexSync.Result.ALREADY_PRESENT, outcome.result);
  }

  @Test
  public void aMalformed200IsStillTreatedAsStored()
  {
    final TrafficIndexSync.Outcome outcome = TrafficIndexSync.interpret(200, "not json");
    assertEquals(TrafficIndexSync.Result.UPLOADED, outcome.result);
  }

  @Test
  public void theServersOwnErrorMessageIsSurfaced()
  {
    final TrafficIndexSync.Outcome outcome = TrafficIndexSync.interpret(
        400, "{\"error\":\"index is for Foo@1, headers say Bar@2\"}");

    assertEquals(TrafficIndexSync.Result.FAILED, outcome.result);
    assertNotNull(outcome.detail);
    assertTrue(outcome.detail.contains("headers say"));
  }

  @Test
  public void anUnpairedDeviceGetsAnActionableMessage()
  {
    final TrafficIndexSync.Outcome outcome = TrafficIndexSync.interpret(401, "");

    assertEquals(TrafficIndexSync.Result.FAILED, outcome.result);
    assertNotNull(outcome.detail);
    assertTrue(outcome.detail.contains("not paired"));
  }

  @Test
  public void anUnexplainedFailureStillReportsTheStatus()
  {
    final TrafficIndexSync.Outcome outcome = TrafficIndexSync.interpret(503, "");

    assertEquals(TrafficIndexSync.Result.FAILED, outcome.result);
    assertNotNull(outcome.detail);
    assertTrue(outcome.detail.contains("503"));
  }
}
