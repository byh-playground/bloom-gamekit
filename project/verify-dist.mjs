import { fileURLToPath } from 'node:url';
import { readVerifiedDistribution } from './distribution.mjs';
try {
    const { manifestHash: MANIFEST_HASH } = await readVerifiedDistribution(
        fileURLToPath(new URL('../', import.meta.url)),
        process.env.EXPECTED_MANIFEST_SHA256,
    );
    // GitHub job output에는 검증한 canonical manifest의 hash 하나만 전달합니다.
    console.log(MANIFEST_HASH);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
