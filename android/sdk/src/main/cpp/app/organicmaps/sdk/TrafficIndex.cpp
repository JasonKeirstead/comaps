#include "Framework.hpp"

#include "app/organicmaps/sdk/core/jni_helper.hpp"

#include "traffic/traffic_index_generator.hpp"

#include "storage/storage.hpp"

#include "platform/local_country_file.hpp"
#include "platform/local_country_file_utils.hpp"

#include "base/logging.hpp"

#include <string>
#include <vector>

// Builds a traffic index from a map already on the device, so the phone can supply its own
// traffic service with one instead of the user running generator_tool on a desktop.
//
// The index is per (country, map version), not per device, and it must match the exact map
// build the client reports -- feature ids are positional within a map release. Deriving it here
// means it is always in step with what is actually installed, including after a map update.
extern "C"
{
// Returns the .cmti bytes for a downloaded map, or null if it could not be built.
// A null bbox means the whole mwm, which only makes sense for small regions -- generation is
// refused above maxSegments either way.
JNIEXPORT jbyteArray JNICALL Java_app_organicmaps_sdk_traffic_TrafficIndex_nativeBuild(
    JNIEnv * env, jclass, jstring countryId, jdouble minLat, jdouble minLon, jdouble maxLat, jdouble maxLon,
    jint maxSegments)
{
  CHECK(g_framework, ("Framework isn't created yet!"));

  std::string const country = jni::ToNativeString(env, countryId);

  // Find the installed map file and its version. Registering happens at startup, so anything
  // the user has downloaded is known to Storage.
  auto const & storage = g_framework->NativeFramework()->GetStorage();
  auto const localFile = storage.GetLatestLocalFile(storage::CountryId(country));
  if (!localFile)
  {
    LOG(LWARNING, ("No downloaded map for", country));
    return nullptr;
  }

  std::string const mwmPath = localFile->GetPath(MapFileType::Map);
  auto const version = static_cast<uint64_t>(localFile->GetVersion());

  traffic::TrafficIndexParams params;
  params.m_maxSegments = static_cast<size_t>(maxSegments);
  params.m_minLat = static_cast<double>(minLat);
  params.m_minLon = static_cast<double>(minLon);
  params.m_maxLat = static_cast<double>(maxLat);
  params.m_maxLon = static_cast<double>(maxLon);

  std::vector<uint8_t> const buffer = traffic::GenerateTrafficIndexBuffer(mwmPath, country, version, params);
  if (buffer.empty())
  {
    LOG(LWARNING, ("Could not build a traffic index for", country, "version", version));
    return nullptr;
  }

  jbyteArray result = env->NewByteArray(static_cast<jsize>(buffer.size()));
  if (result == nullptr)
    return nullptr;
  env->SetByteArrayRegion(result, 0, static_cast<jsize>(buffer.size()),
                          reinterpret_cast<jbyte const *>(buffer.data()));
  return result;
}

// The map version the index was built for. The service stores indexes per version, and the
// client asks for its own version by name, so the uploader has to send them together.
JNIEXPORT jlong JNICALL Java_app_organicmaps_sdk_traffic_TrafficIndex_nativeMapVersion(JNIEnv * env, jclass,
                                                                                       jstring countryId)
{
  CHECK(g_framework, ("Framework isn't created yet!"));

  auto const & storage = g_framework->NativeFramework()->GetStorage();
  auto const localFile = storage.GetLatestLocalFile(storage::CountryId(jni::ToNativeString(env, countryId)));
  return localFile ? static_cast<jlong>(localFile->GetVersion()) : 0;
}
}  // extern "C"
