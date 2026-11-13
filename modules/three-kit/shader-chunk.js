// 셰이더 주입은 three.js 내장 셰이더 소스의 문자열을 바꿔 끼우는 일이라, three가 그 문자열을 바꾸면 주입이 빠진 채 컴파일됩니다.
// 이 모듈의 모든 주입은 아래 함수 하나를 거치며, 바꿀 대상이 없으면 조용히 넘어가지 않고 오류를 냅니다.
// onBeforeCompile 안에서 불리므로 오류는 첫 컴파일 때 납니다. warmUp으로 로딩 때 컴파일하면 로딩 단계에서 드러납니다.

/** 주입 대상 문자열을 확인한 three.js revision. README "지원 revision"과 같은 값입니다. */
const CHECKED_REVISIONS = 'r170·r180·r186';

/**
 * source에서 target(처음 한 번)을 replacement로 바꿉니다. target이 없으면 오류를 냅니다.
 * @param {string} source onBeforeCompile이 받은 shader.vertexShader 또는 shader.fragmentShader
 * @param {string} target 바꿀 문자열(예: '#include <begin_vertex>')
 * @param {string} replacement 대신 넣을 문자열. target을 남기려면 replacement 안에 target을 다시 씁니다.
 * @returns {string}
 */
export function replaceShaderChunk(source, target, replacement) {
    if (typeof source !== 'string' || !source.includes(target)) {
        throw new Error(
            `three-kit: 셰이더에 주입 대상 "${target}"이 없습니다. three.js revision을 확인하세요(확인한 revision: ${CHECKED_REVISIONS}).`,
        );
    }
    return source.replace(target, () => replacement);
}
