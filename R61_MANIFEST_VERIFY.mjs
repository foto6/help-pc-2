import { verifyR45Release } from './bin/pc-autonomy-daemon.js';
const runner = 'E:\\PCControlAutonomyR61-SHADOW\\autonomy-r45-runner.js';
const sha = 'd17d0cfe8037b157cc28cef2f8cd3ad3420f6fa2';
const resolved = verifyR45Release({r45:{runner,sha}});
if (resolved !== runner) throw Error('RUNNER_PATH_MISMATCH: '+resolved);
console.log('R61_R41_NINE_BLOB_MANIFEST_VALID');