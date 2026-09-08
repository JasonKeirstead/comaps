package app.organicmaps.maplayer;

import app.organicmaps.sdk.maplayer.Mode;
import java.util.ArrayList;
import java.util.List;

public class LayersUtils
{
  public static List<Mode> getAvailableLayers()
  {
    List<Mode> availableLayers = new ArrayList<>();
    availableLayers.add(Mode.OUTDOORS);
    availableLayers.add(Mode.ISOLINES);
    availableLayers.add(Mode.SUBWAY);
    // Traffic needs a self-hosted server (Settings -> Advanced -> Traffic server). With none
    // configured the layer draws nothing, which is why it stayed hidden until now.
    availableLayers.add(Mode.TRAFFIC);
    return availableLayers;
  }
}
