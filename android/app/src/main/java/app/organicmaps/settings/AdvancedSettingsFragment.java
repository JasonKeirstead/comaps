package app.organicmaps.settings;
import androidx.annotation.Keep;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.preference.Preference;
import androidx.preference.PreferenceManager;
import androidx.preference.TwoStatePreference;
import app.organicmaps.R;
import app.organicmaps.dialog.CustomMapServerDialog;
import app.organicmaps.dialog.TrafficServerDialog;
import app.organicmaps.sdk.Framework;
import app.organicmaps.sdk.util.Config;
import app.organicmaps.sdk.util.SharedPropertiesUtils;
import app.organicmaps.sdk.util.log.LogsManager;
import app.organicmaps.traffic.TrafficIndexSync;
import app.organicmaps.traffic.TrafficPairingActivity;
import app.organicmaps.util.Utils;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;

@Keep
public class AdvancedSettingsFragment extends BaseXmlSettingsFragment
{
  @Override
  protected int getXmlResources()
  {
    return R.xml.prefs_advanced;
  }

  @Override
  public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState)
  {
    super.onViewCreated(view, savedInstanceState);

    initLoggingEnabledPrefsCallbacks();
    initEmulationBadStorage();
    initOpenExternalLinksPrefsCallback();
    initCustomMapDownloadUrlPrefsCallbacks();
    initTrafficServerPrefsCallbacks();
  }

  @Override
  public boolean onPreferenceTreeClick(Preference preference)
  {
    final String key = preference.getKey();
    if (key == null)
      return super.onPreferenceTreeClick(preference);

    if (key.equals(getString(R.string.pref_open_external_links)))
    {
      final Intent intent = new Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS);
      intent.setData(Uri.fromParts("package", requireContext().getPackageName(), null));
      startActivity(intent);
    }
    return super.onPreferenceTreeClick(preference);
  }

  private void initLoggingEnabledPrefsCallbacks()
  {
    final Preference pref = getPreference(getString(R.string.pref_enable_logging));
    ((TwoStatePreference) pref).setChecked(LogsManager.INSTANCE.isFileLoggingEnabled());
    pref.setOnPreferenceChangeListener((preference, newValue) -> {
      if (!LogsManager.INSTANCE.setFileLoggingEnabled((Boolean) newValue))
      {
        Utils.showSnackbar(requireView(), "ERROR: Can't create a logs folder!");
        return false;
      }
      return true;
    });
  }

  private void initEmulationBadStorage()
  {
    final Preference pref = findPreference(getString(R.string.pref_emulate_bad_external_storage));
    if (pref == null)
      return;
    if (!SharedPropertiesUtils.shouldShowEmulateBadStorageSetting())
      pref.setVisible(false);
  }

  private void initOpenExternalLinksPrefsCallback()
  {
    Preference openExternalLinksPref = getPreference(getString(R.string.pref_open_external_links));
    openExternalLinksPref.setVisible(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
  }

  private void initCustomMapDownloadUrlPrefsCallbacks()
  {
    Preference customUrlPref = getPreference(getString(R.string.pref_custom_map_download_url));

    SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(requireContext());

    String current = prefs.getString(getString(R.string.pref_custom_map_download_url), "");
    String normalizedUrl = Framework.normalizeServerUrl(current);

    customUrlPref.setSummary(normalizedUrl.isEmpty() ? getString(R.string.download_resources_custom_url_summary_none)
                                                     : normalizedUrl);

    Framework.applyCustomMapDownloadUrl(requireContext(), normalizedUrl);

    customUrlPref.setOnPreferenceClickListener(preference -> {
      CustomMapServerDialog.show(
          requireContext(),
          url
          -> preference.setSummary(url.isEmpty() ? getString(R.string.download_resources_custom_url_summary_none)
                                                 : url));
      return true;
    });
  }

  private void initTrafficServerPrefsCallbacks()
  {
    Preference trafficPref = getPreference(getString(R.string.pref_traffic_server_url));
    updateTrafficServerSummary(trafficPref);

    trafficPref.setOnPreferenceClickListener(preference -> {
      showTrafficServerChooser(preference);
      return true;
    });
  }

  private void updateTrafficServerSummary(@NonNull Preference preference)
  {
    String url = Config.getTrafficServerUrl();
    preference.setSummary(url.isEmpty() ? getString(R.string.traffic_server_summary_none) : url);
  }

  private void showTrafficServerChooser(@NonNull Preference preference)
  {
    boolean configured = !Config.getTrafficServerUrl().isEmpty();

    // With no server yet, deploying leads: there is otherwise nothing in the app telling you that
    // traffic needs a server at all, let alone where to get one. Covering an area and
    // disconnecting only make sense once one exists.
    CharSequence[] options = configured ? new CharSequence[] {getString(R.string.traffic_server_scan),
                                                              getString(R.string.traffic_server_manual),
                                                              getString(R.string.traffic_server_cover_area),
                                                              getString(R.string.traffic_server_disconnect)}
                                        : new CharSequence[] {getString(R.string.traffic_server_deploy),
                                                              getString(R.string.traffic_server_scan),
                                                              getString(R.string.traffic_server_manual)};

    new MaterialAlertDialogBuilder(requireContext())
        .setTitle(R.string.traffic_server_title)
        .setItems(options,
                  (dialog, which) -> {
                    // The unconfigured list leads with Deploy, so everything after it shifts.
                    if (!configured && which == 0)
                    {
                      showDeployPrompt();
                      return;
                    }
                    final int action = configured ? which : which - 1;
                    switch (action)
                    {
                    case 0:
                      startActivity(new Intent(requireContext(), TrafficPairingActivity.class));
                      break;
                    case 1:
                      TrafficServerDialog.show(requireContext(), url -> updateTrafficServerSummary(preference));
                      break;
                    case 2:
                      coverCurrentArea();
                      break;
                    default:
                      Framework.nativeSetTrafficServer("", "");
                      updateTrafficServerSummary(preference);
                      break;
                    }
                  })
        .setNegativeButton(R.string.cancel, null)
        .show();
  }

  /**
   * Hands off to Cloudflare's deploy flow in a browser.
   * <p>
   * Deliberately a hand-off rather than deploying from the app: Cloudflare authenticates the user
   * in its own flow, so no cloud credential ever reaches the phone. The deploy finishes with a
   * pairing code to scan back here.
   */
  private void showDeployPrompt()
  {
    new MaterialAlertDialogBuilder(requireContext())
        .setTitle(R.string.traffic_server_deploy)
        .setMessage(R.string.traffic_server_deploy_summary)
        .setNegativeButton(R.string.cancel, null)
        .setPositiveButton(R.string.ok,
                           (d, w) -> Utils.openUrl(requireContext(), getString(R.string.traffic_server_deploy_url)))
        .show();
  }

  /**
   * Sends map data for the visible area to the user's traffic server.
   * <p>
   * The server needs an index per (map, map version) to answer at all, and that set changes as
   * maps are downloaded and updated. Rather than making the user run a desktop tool, the app
   * builds one from the map it already has, for wherever they are looking.
   */
  private void coverCurrentArea()
  {
    final String baseUrl = Config.getTrafficServerUrl();
    final String apiKey = Config.getTrafficApiKey();
    if (baseUrl.isEmpty())
    {
      Utils.showSnackbar(requireView(), getString(R.string.traffic_server_not_configured));
      return;
    }

    final double[] center = Framework.nativeGetScreenRectCenter();
    Utils.showSnackbar(requireView(), getString(R.string.traffic_server_covering));

    // Reading the map and uploading are both slow enough to matter; keep them off the UI thread.
    new Thread(() -> {
      final TrafficIndexSync.Outcome outcome = TrafficIndexSync.syncAround(baseUrl, apiKey, center[0], center[1]);

      final View view = getView();
      if (view == null)
        return;

      view.post(() -> {
        final View current = getView();
        if (current != null)
          Utils.showSnackbar(current, describe(outcome));
      });
    }, "traffic-index-sync").start();
  }

  @NonNull
  private String describe(@NonNull TrafficIndexSync.Outcome outcome)
  {
    final String detail = outcome.detail == null ? "" : outcome.detail;
    switch (outcome.result)
    {
    case UPLOADED: return getString(R.string.traffic_server_covered, outcome.countryId);
    case ALREADY_PRESENT: return getString(R.string.traffic_server_already_covered, outcome.countryId);
    case TOO_LARGE: return getString(R.string.traffic_server_area_too_large);
    case NOT_DOWNLOADED: return getString(R.string.traffic_server_no_map);
    default: return getString(R.string.traffic_server_cover_failed, detail);
    }
  }

  @Override
  public void onResume()
  {
    super.onResume();

    // The pairing activity writes the settings itself, so refresh the summary on the way back.
    Preference trafficPref = findPreference(getString(R.string.pref_traffic_server_url));
    if (trafficPref != null)
      updateTrafficServerSummary(trafficPref);
  }
}
