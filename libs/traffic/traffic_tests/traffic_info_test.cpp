#include "testing/testing.hpp"

#include "traffic/speed_groups.hpp"
#include "traffic/traffic_info.hpp"

#include "platform/local_country_file.hpp"
#include "platform/platform_tests_support/writable_dir_changer.hpp"

#include "indexer/mwm_set.hpp"

#include "coding/hex.hpp"
#include "coding/zlib.hpp"

#include "cppjansson/cppjansson.hpp"

#include "base/string_utils.hpp"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace std;

namespace traffic
{
namespace
{
string const & kMapTestDir = "traffic-test";

class TestMwmSet : public MwmSet
{
protected:
  // MwmSet overrides:
  unique_ptr<MwmInfo> CreateInfo(platform::LocalCountryFile const &) const override
  {
    unique_ptr<MwmInfo> info(new MwmInfo());
    info->m_version.SetFormat(version::Format::lastFormat);
    return info;
  }

  unique_ptr<MwmValue> CreateValue(MwmInfo & info) const override { return make_unique<MwmValue>(info.GetLocalFile()); }
};
}  // namespace

/// @todo Need TRAFFIC_DATA_BASE_URL for this test.
/*
UNIT_TEST(TrafficInfo_RemoteFile)
{
  WritableDirChanger writableDirChanger(kMapTestDir);
  {
    TestMwmSet mwmSet;
    auto const & r =
        mwmSet.Register(platform::LocalCountryFile::MakeForTesting("traffic_data_test"));
    TrafficInfo trafficInfo(r.first, r.first.GetInfo()->GetVersion());
    string etag;
    TEST(trafficInfo.ReceiveTrafficData(etag), ());
  }
  {
    TestMwmSet mwmSet;
    auto const & r =
        mwmSet.Register(platform::LocalCountryFile::MakeForTesting("traffic_data_test2"));
    TrafficInfo trafficInfo(r.first, r.first.GetInfo()->GetVersion());
    string etag;
    TEST(!trafficInfo.ReceiveTrafficData(etag), ());
  }
  {
    TestMwmSet mwmSet;
    auto const & r =
        mwmSet.Register(platform::LocalCountryFile::MakeForTesting("traffic_data_test", 101010));
    TrafficInfo trafficInfo(r.first, r.first.GetInfo()->GetVersion());
    string etag;
    TEST(trafficInfo.ReceiveTrafficData(etag), ());
  }
}
*/

UNIT_TEST(TrafficInfo_Serialization)
{
  TrafficInfo::Coloring coloring = {
      {TrafficInfo::RoadSegmentId(0, 0, 0), SpeedGroup::G0},

      {TrafficInfo::RoadSegmentId(1, 0, 0), SpeedGroup::G1},
      {TrafficInfo::RoadSegmentId(1, 0, 1), SpeedGroup::G3},

      {TrafficInfo::RoadSegmentId(5, 0, 0), SpeedGroup::G2},
      {TrafficInfo::RoadSegmentId(5, 0, 1), SpeedGroup::G2},
      {TrafficInfo::RoadSegmentId(5, 1, 0), SpeedGroup::G2},
      {TrafficInfo::RoadSegmentId(5, 1, 1), SpeedGroup::G5},

      {TrafficInfo::RoadSegmentId(4294967295, 0, 0), SpeedGroup::TempBlock},
  };

  vector<TrafficInfo::RoadSegmentId> keys;
  vector<SpeedGroup> values;
  for (auto const & kv : coloring)
  {
    keys.push_back(kv.first);
    values.push_back(kv.second);
  }

  {
    vector<uint8_t> buf;
    TrafficInfo::SerializeTrafficKeys(keys, buf);

    vector<TrafficInfo::RoadSegmentId> deserializedKeys;
    TrafficInfo::DeserializeTrafficKeys(buf, deserializedKeys);

    TEST(is_sorted(keys.begin(), keys.end()), ());
    TEST(is_sorted(deserializedKeys.begin(), deserializedKeys.end()), ());
    TEST_EQUAL(keys, deserializedKeys, ());
  }

  {
    vector<uint8_t> buf;
    TrafficInfo::SerializeTrafficValues(values, buf);

    vector<SpeedGroup> deserializedValues;
    TrafficInfo::DeserializeTrafficValues(buf, deserializedValues);
    TEST_EQUAL(values, deserializedValues, ());
  }
}

// Cross-language conformance against tools/traffic_server (the self-hosted traffic service).
//
// Both this test and tools/traffic_server/test/wire.test.ts read golden_traffic_vectors.json,
// so the C++ client and the TypeScript server cannot drift apart. The vectors carry the exact
// expected bytes for the keys blob and for the values payload *before* deflation -- zlib output
// is implementation-defined and must not be goldened.
UNIT_TEST(TrafficInfo_GoldenVectors)
{
  ifstream ifs(GOLDEN_TRAFFIC_VECTORS_PATH);
  TEST(ifs.is_open(), ("Cannot open", GOLDEN_TRAFFIC_VECTORS_PATH));
  stringstream ss;
  ss << ifs.rdbuf();

  base::Json root(ss.str().c_str());
  json_t * vectors = json_object_get(root.get(), "vectors");
  TEST(json_is_array(vectors), ());

  size_t const numVectors = json_array_size(vectors);
  TEST_GREATER(numVectors, 0, ());

  for (size_t v = 0; v < numVectors; ++v)
  {
    json_t * vec = json_array_get(vectors, v);
    string const name = json_string_value(json_object_get(vec, "name"));

    // Rebuild the key list the client would expand the blob into.
    vector<TrafficInfo::RoadSegmentId> keys;
    json_t * features = json_object_get(vec, "features");
    for (size_t i = 0; i < json_array_size(features); ++i)
    {
      json_t * f = json_array_get(features, i);
      auto const fid = static_cast<uint32_t>(json_integer_value(json_object_get(f, "fid")));
      auto const numSegs = static_cast<uint16_t>(json_integer_value(json_object_get(f, "numSegs")));
      uint8_t const numDirs = json_is_true(json_object_get(f, "oneWay")) ? 1 : 2;
      for (uint16_t idx = 0; idx < numSegs; ++idx)
        for (uint8_t dir = 0; dir < numDirs; ++dir)
          keys.emplace_back(fid, idx, dir);
    }

    vector<SpeedGroup> values;
    json_t * jsonValues = json_object_get(vec, "values");
    for (size_t i = 0; i < json_array_size(jsonValues); ++i)
    {
      string const g = json_string_value(json_array_get(jsonValues, i));
      SpeedGroup group = SpeedGroup::Unknown;
      for (uint8_t k = 0; k < static_cast<uint8_t>(SpeedGroup::Count); ++k)
      {
        if (DebugPrint(static_cast<SpeedGroup>(k)) == g)
        {
          group = static_cast<SpeedGroup>(k);
          break;
        }
      }
      values.push_back(group);
    }
    TEST_EQUAL(keys.size(), values.size(), (name));

    // Keys: the blob is served verbatim, so it must match byte for byte.
    string const expectedKeysHex = json_string_value(json_object_get(vec, "keysHex"));
    {
      vector<uint8_t> buf;
      TrafficInfo::SerializeTrafficKeys(keys, buf);
      TEST_EQUAL(strings::MakeLowerCase(ToHex(buf)), expectedKeysHex, ("keys mismatch for", name));
    }

    // ... and the client must decode the server's bytes back to the same keys.
    {
      string const raw = FromHex(expectedKeysHex);
      vector<uint8_t> const blob(raw.begin(), raw.end());
      vector<TrafficInfo::RoadSegmentId> decoded;
      TrafficInfo::DeserializeTrafficKeys(blob, decoded);
      TEST_EQUAL(keys, decoded, ("keys did not round-trip for", name));
    }

    // Values: compare the inner payload, since the deflated bytes are not portable.
    {
      vector<uint8_t> buf;
      TrafficInfo::SerializeTrafficValues(values, buf);

      vector<uint8_t> plain;
      coding::ZLib::Inflate inflate(coding::ZLib::Inflate::Format::ZLib);
      inflate(buf.data(), buf.size(), back_inserter(plain));

      string const expectedValuesHex = json_string_value(json_object_get(vec, "valuesPlainHex"));
      TEST_EQUAL(strings::MakeLowerCase(ToHex(plain)), expectedValuesHex, ("values mismatch for", name));
    }
  }
}

UNIT_TEST(TrafficInfo_UpdateTrafficData)
{
  vector<TrafficInfo::RoadSegmentId> const keys = {
      TrafficInfo::RoadSegmentId(0, 0, 0),

      TrafficInfo::RoadSegmentId(1, 0, 0),
      TrafficInfo::RoadSegmentId(1, 0, 1),
  };

  vector<SpeedGroup> const values1 = {
      SpeedGroup::G1,
      SpeedGroup::G2,
      SpeedGroup::G3,
  };

  vector<SpeedGroup> const values2 = {
      SpeedGroup::G4,
      SpeedGroup::G5,
      SpeedGroup::Unknown,
  };

  TrafficInfo info;
  info.SetTrafficKeysForTesting(keys);

  TEST(info.UpdateTrafficData(values1), ());
  for (size_t i = 0; i < keys.size(); ++i)
    TEST_EQUAL(info.GetSpeedGroup(keys[i]), values1[i], ());

  TEST(info.UpdateTrafficData(values2), ());
  for (size_t i = 0; i < keys.size(); ++i)
    TEST_EQUAL(info.GetSpeedGroup(keys[i]), values2[i], ());
}
}  // namespace traffic
