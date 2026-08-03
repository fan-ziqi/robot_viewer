function cubic(a, b, c, d, t) {
    const inverse = 1 - t;
    return inverse ** 3 * a
        + 3 * inverse ** 2 * t * b
        + 3 * inverse * t ** 2 * c
        + t ** 3 * d;
}

function solveTime(x0, x1, x2, x3, target) {
    let low = 0;
    let high = 1;
    let t = (target - x0) / Math.max(1, x3 - x0);

    for (let index = 0; index < 14; index++) {
        const x = cubic(x0, x1, x2, x3, t);
        if (Math.abs(x - target) < 0.01) break;
        if (x < target) low = t;
        else high = t;
        t = (low + high) / 2;
    }
    return t;
}

export function evaluateTrack(track, timeMs) {
    const keyframes = track?.keyframes || [];
    if (keyframes.length === 0) return null;
    if (keyframes.length === 1 || timeMs <= keyframes[0].timeMs) return keyframes[0].value;
    if (timeMs >= keyframes[keyframes.length - 1].timeMs) return keyframes[keyframes.length - 1].value;

    let low = 0;
    let high = keyframes.length - 1;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (keyframes[middle].timeMs <= timeMs) low = middle;
        else high = middle;
    }

    const left = keyframes[low];
    const right = keyframes[high];
    const span = right.timeMs - left.timeMs;
    const progress = span > 0 ? (timeMs - left.timeMs) / span : 0;

    if (left.interpolation === 'step') return left.value;
    if (left.interpolation === 'linear') {
        return left.value + (right.value - left.value) * progress;
    }

    let x1 = Math.min(right.timeMs, Math.max(left.timeMs, left.timeMs + (left.outHandle?.dxMs ?? span / 3)));
    let x2 = Math.min(right.timeMs, Math.max(left.timeMs, right.timeMs + (right.inHandle?.dxMs ?? -span / 3)));
    if (x1 > x2) {
        const middle = (x1 + x2) / 2;
        x1 = middle;
        x2 = middle;
    }
    const y1 = left.value + (left.outHandle?.dy ?? 0);
    const y2 = right.value + (right.inHandle?.dy ?? 0);
    const t = solveTime(left.timeMs, x1, x2, right.timeMs, timeMs);
    return cubic(left.value, y1, y2, right.value, t);
}

export function evaluateClip(clip, timeMs) {
    const pose = {};
    clip?.tracks?.forEach((track) => {
        if (track.muted || track.type !== 'joint') return;
        const value = evaluateTrack(track, timeMs);
        if (value !== null) pose[track.jointName] = value;
    });
    return pose;
}
