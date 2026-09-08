/**
 * Mirrors libs/traffic/speed_groups.{hpp,cpp}.
 *
 * A const object rather than a TS `enum` so the sources run under Node's type-stripping
 * without a build step.
 */

export const SpeedGroup = {
  G0: 0,
  G1: 1,
  G2: 2,
  G3: 3,
  G4: 4,
  G5: 5,
  TempBlock: 6,
  Unknown: 7,
} as const;

export type SpeedGroupName = keyof typeof SpeedGroup;
export type SpeedGroupValue = (typeof SpeedGroup)[SpeedGroupName];

export const SPEED_GROUP_COUNT = 8;

/**
 * kSpeedGroupThresholdPercentage: the maximum V/M ratio, as a percentage, for each group.
 * The last three are 100 because V is unknown or undefined there.
 */
export const SPEED_GROUP_THRESHOLDS = [8, 16, 33, 58, 83, 100, 100, 100] as const;

/**
 * Maps a percentage of free-flow speed to a group, reproducing GetSpeedGroupByPercentage.
 *
 * The C++ scans downward keeping the last match, which yields the *smallest* index whose
 * threshold is >= p. Since p is clamped to <= 100 it always matches G5 first, so this can
 * never return TempBlock or Unknown -- those must be assigned deliberately by the caller.
 */
export function speedGroupByPercentage(p: number): SpeedGroupValue {
  const clamped = Math.min(100, Math.max(0, p));
  for (let i = 0; i < SPEED_GROUP_THRESHOLDS.length; i++) {
    if (clamped <= SPEED_GROUP_THRESHOLDS[i]) return i as SpeedGroupValue;
  }
  return SpeedGroup.Unknown;
}

/** Convenience for providers that report a current and a free-flow speed. */
export function speedGroupFromSpeeds(currentSpeed: number, freeFlowSpeed: number): SpeedGroupValue {
  if (!(freeFlowSpeed > 0)) return SpeedGroup.Unknown;
  return speedGroupByPercentage((100 * currentSpeed) / freeFlowSpeed);
}
