#pragma once

#include "indexer/ftypes_matcher.hpp"

#include <cstdint>
#include <set>
#include <string>

namespace traffic
{
struct TrafficIndexParams
{
  // Coverage is a bounded area -- a city, a metro, a commute corridor -- not a whole country.
  // An index for a large region would be useless in practice: the key list is fetched by the
  // client on every session, held in memory as 8 bytes per directional segment, and no traffic
  // provider has data for most of it. Generation is refused above this many segments.
  size_t m_maxSegments = 250000;

  // Degrees. An empty rect means the whole mwm, which is only sensible for small extracts.
  double m_minLat = -90.0;
  double m_minLon = -180.0;
  double m_maxLat = 90.0;
  double m_maxLon = 180.0;

  // Defaults to the renderer's RoadClass::Class0 + Class1, which are drawn from zoom 10 and 12.
  // Anything below that (residential, service, track) only appears from zoom 15, is where the
  // segment count explodes, and is where incident providers have nothing to say.
  std::set<ftypes::HighwayClass> m_roadClasses = {
      ftypes::HighwayClass::Motorway, ftypes::HighwayClass::Trunk, ftypes::HighwayClass::Primary,
      ftypes::HighwayClass::Secondary, ftypes::HighwayClass::Tertiary};

  // Grid resolution used to bucket segments for incident matching.
  uint32_t m_gridCols = 128;
  uint32_t m_gridRows = 128;
};

// Writes a "CMTI" traffic index for |mwmPath| to |outPath|, for use by
// tools/traffic_server. The index carries the byte-exact .traffic.keys blob plus a
// representative point per segment, so the service never has to parse an mwm -- which it could
// not do on Cloudflare Workers in any case.
//
// Returns false and logs the reason on failure, including when the area exceeds
// |params.m_maxSegments|.
bool GenerateTrafficIndex(std::string const & mwmPath, std::string const & outPath, std::string const & countryName,
                          uint64_t mwmVersion, TrafficIndexParams const & params);
}  // namespace traffic
