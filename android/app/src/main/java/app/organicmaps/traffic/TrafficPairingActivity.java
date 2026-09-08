package app.organicmaps.traffic;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import app.organicmaps.R;
import app.organicmaps.sdk.Framework;
import app.organicmaps.sdk.util.log.Logger;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import java.nio.ByteBuffer;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Scans the QR code that pairs this app with a self-hosted traffic server.
 * <p>
 * The scan yields a short-lived token, which is exchanged over HTTP for a long-lived API key.
 * See {@link TrafficPairing} for the payload format and the exchange itself.
 */
public class TrafficPairingActivity extends AppCompatActivity
{
  private static final String TAG = TrafficPairingActivity.class.getSimpleName();

  private ExecutorService mCameraExecutor;
  private ExecutorService mNetworkExecutor;
  private PreviewView mPreviewView;
  private ProgressBar mProgress;

  // A single scan can produce several frames with the same code before the camera unbinds.
  private final AtomicBoolean mHandled = new AtomicBoolean(false);

  private final ActivityResultLauncher<String> mCameraPermission =
      registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
        if (granted)
          startCamera();
        else
          finishWithMessage(getString(R.string.traffic_server_camera_denied));
      });

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState)
  {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_traffic_pairing);

    mPreviewView = findViewById(R.id.camera_preview);
    mProgress = findViewById(R.id.scan_progress);
    mCameraExecutor = Executors.newSingleThreadExecutor();
    mNetworkExecutor = Executors.newSingleThreadExecutor();

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
      startCamera();
    else
      mCameraPermission.launch(Manifest.permission.CAMERA);
  }

  @Override
  protected void onDestroy()
  {
    super.onDestroy();
    if (mCameraExecutor != null)
      mCameraExecutor.shutdown();
    if (mNetworkExecutor != null)
      mNetworkExecutor.shutdown();
  }

  private void startCamera()
  {
    final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
    future.addListener(() -> {
      try
      {
        final ProcessCameraProvider provider = future.get();

        final Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(mPreviewView.getSurfaceProvider());

        final ImageAnalysis analysis =
            new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
        analysis.setAnalyzer(mCameraExecutor, this::analyze);

        provider.unbindAll();
        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
      }
      catch (Exception e)
      {
        Logger.e(TAG, "Could not start the camera", e);
        finishWithMessage(getString(R.string.traffic_server_camera_denied));
      }
    }, ContextCompat.getMainExecutor(this));
  }

  private void analyze(@NonNull ImageProxy image)
  {
    try
    {
      if (mHandled.get())
        return;

      final String text = decodeQr(image);
      if (text == null)
        return;

      final TrafficPairing.PairingRequest request = TrafficPairing.parse(text);
      // Not a CoMaps pairing code: ignore it and keep scanning rather than complaining about
      // every stray barcode that happens to be in frame.
      if (request == null)
        return;

      if (mHandled.compareAndSet(false, true))
        runOnUiThread(() -> pair(request));
    }
    finally
    {
      image.close();
    }
  }

  @Nullable
  private String decodeQr(@NonNull ImageProxy image)
  {
    // Plane 0 of YUV_420_888 is luminance, which is all ZXing needs.
    final ByteBuffer buffer = image.getPlanes()[0].getBuffer();
    final byte[] data = new byte[buffer.remaining()];
    buffer.get(data);

    final int width = image.getWidth();
    final int height = image.getHeight();
    final PlanarYUVLuminanceSource source =
        new PlanarYUVLuminanceSource(data, image.getPlanes()[0].getRowStride(), height, 0, 0, width, height, false);

    final Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, java.util.Collections.singletonList(com.google.zxing.BarcodeFormat.QR_CODE));

    try
    {
      final Result result = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
      return result.getText();
    }
    catch (NotFoundException e)
    {
      // No code in this frame; entirely normal.
      return null;
    }
    catch (Exception e)
    {
      Logger.w(TAG, "QR decoding failed", e);
      return null;
    }
  }

  private void pair(@NonNull TrafficPairing.PairingRequest request)
  {
    mProgress.setVisibility(View.VISIBLE);

    final String deviceName = Build.MANUFACTURER + " " + Build.MODEL;
    mNetworkExecutor.execute(() -> {
      try
      {
        final TrafficPairing.PairingResult result = TrafficPairing.redeem(request, deviceName);
        runOnUiThread(() -> {
          Framework.nativeSetTrafficServer(result.baseUrl, result.apiKey);
          final String label = result.serverName.isEmpty() ? result.baseUrl : result.serverName;
          finishWithMessage(getString(R.string.traffic_server_paired, label));
        });
      }
      catch (TrafficPairing.PairingException e)
      {
        Logger.e(TAG, "Pairing failed", e);
        runOnUiThread(() -> {
          mProgress.setVisibility(View.GONE);
          // Let the user try again with a fresh code without leaving the screen.
          mHandled.set(false);
          Toast.makeText(this, getString(R.string.traffic_server_pair_failed, e.getMessage()), Toast.LENGTH_LONG)
              .show();
        });
      }
    });
  }

  private void finishWithMessage(@NonNull String message)
  {
    runOnUiThread(() -> {
      Toast.makeText(this, message, Toast.LENGTH_LONG).show();
      finish();
    });
  }
}
