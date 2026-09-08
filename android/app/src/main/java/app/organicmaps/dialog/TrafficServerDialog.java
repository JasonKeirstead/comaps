package app.organicmaps.dialog;

import android.content.Context;
import android.content.DialogInterface;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import app.organicmaps.R;
import app.organicmaps.sdk.Framework;
import app.organicmaps.sdk.util.Config;
import app.organicmaps.traffic.TrafficPairing;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;

/**
 * Manual entry of a self-hosted traffic server's address and key.
 * <p>
 * The QR scanner is the usual path, but this one works with no camera, no camera permission and
 * no working scan, so it is also the path to reach for when debugging a server.
 */
public final class TrafficServerDialog
{
  public interface OnAppliedListener
  {
    void onApplied(@NonNull String url);
  }

  private TrafficServerDialog() {}

  public static void show(@NonNull Context context, @Nullable OnAppliedListener listener)
  {
    View dialogView = LayoutInflater.from(context).inflate(R.layout.dialog_traffic_server, null);
    TextInputLayout urlLayout = dialogView.findViewById(R.id.til_traffic_server_url);
    TextInputEditText urlEdit = dialogView.findViewById(R.id.edit_traffic_server_url);
    TextInputEditText keyEdit = dialogView.findViewById(R.id.edit_traffic_api_key);

    urlEdit.setText(Config.getTrafficServerUrl());
    keyEdit.setText(Config.getTrafficApiKey());

    MaterialAlertDialogBuilder builder = new MaterialAlertDialogBuilder(context)
                                             .setTitle(R.string.traffic_server_title)
                                             .setMessage(R.string.traffic_server_message)
                                             .setView(dialogView)
                                             .setNegativeButton(R.string.cancel, null)
                                             .setPositiveButton(R.string.save, null);

    AlertDialog dialog = builder.create();
    dialog.setOnShowListener(dlg -> {
      Button ok = dialog.getButton(DialogInterface.BUTTON_POSITIVE);
      ok.setOnClickListener(v -> {
        String url = urlEdit.getText() != null ? urlEdit.getText().toString().trim() : "";
        String key = keyEdit.getText() != null ? keyEdit.getText().toString().trim() : "";

        // An empty address means "disconnect", which is a legitimate thing to save.
        String normalizedUrl = "";
        if (!url.isEmpty())
        {
          normalizedUrl = TrafficPairing.normalizeUrl(url);
          if (normalizedUrl == null)
          {
            urlLayout.setError(context.getString(R.string.traffic_server_url_error));
            return;
          }
        }

        urlLayout.setError(null);

        // Goes through native so the traffic manager drops keys cached from the old server.
        Framework.nativeSetTrafficServer(normalizedUrl, key);

        if (listener != null)
          listener.onApplied(normalizedUrl);

        dialog.dismiss();
      });
    });

    dialog.show();
  }
}
