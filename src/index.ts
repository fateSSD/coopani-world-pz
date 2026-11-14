/** 包入口。 */
import { PZ } from './definition.ts';

export default PZ;

export { PZ };
export { PzWorld, PZ_DESCRIBE } from './world.ts';
export { PZ_DEFAULTS, PZ_ID, pzConfigGroups, type PzConfigSection, type Persona } from './config.ts';
export { buildSituation, describeNow, tipsOf, threatBandOf, hpBandOf, type Situation } from './perception.ts';
export { judge, initialJudgeState, type JudgeState, type Outgoing } from './events.ts';
export { resolveRoot, pathsOf, describeTried } from './paths.ts';
export { parseStateLoose, installBridge, readState } from './bridge.ts';
