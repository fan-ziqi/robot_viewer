/**
 * File operation utility functions
 */

/**
 * Read file content as text
 */
export function readFileContent(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

/**
 * Get File object from file system entry
 */
export function getFileFromEntry(entry) {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

/**
 * Recursively read directory
 */
export async function readDirectory(dirEntry, fileMap) {
    const files = [];

    return new Promise((resolve, reject) => {
        const reader = dirEntry.createReader();

        function readEntries() {
            reader.readEntries(async (entries) => {
                if (entries.length === 0) {
                    resolve(files);
                    return;
                }

                for (const entry of entries) {
                    if (entry.isFile) {
                        const file = await getFileFromEntry(entry);
                        const path = entry.fullPath || entry.name;
                        fileMap.set(path, file);
                        files.push(file);
                    } else if (entry.isDirectory) {
                        const subFiles = await readDirectory(entry, fileMap);
                        files.push(...subFiles);
                    }
                }

                readEntries();
            }, reject);
        }

        readEntries();
    });
}

/**
 * Get file type from extension
 */
export function getFileTypeFromExtension(ext) {
    const typeMap = {
        'urdf': 'urdf',
        'xacro': 'xacro',
        'xml': 'mjcf',
        'usd': 'usd',
        'usda': 'usd',
        'usdc': 'usd',
        'usdz': 'usd'
    };
    return typeMap[ext] || 'unknown';
}

/**
 * Get file display type
 */
export function getFileDisplayType(ext, fileName) {
    const modelExts = ['urdf', 'xacro', 'xml', 'usd', 'usda', 'usdc', 'usdz'];
    const meshExts = ['dae', 'stl', 'obj', 'collada'];

    if (modelExts.includes(ext)) {
        return 'model';
    } else if (meshExts.includes(ext)) {
        return 'mesh';
    }
    return 'file';
}

/**
 * Normalize path
 */
export function normalizePath(path) {
    if (!path) return '';
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * Normalize path segments, resolving "." and ".." without touching protocol-like prefixes.
 */
export function cleanFilePath(path) {
    return normalizePath(path)
        .split('/')
        .reduce((parts, part) => {
            if (!part || part === '.') {
                return parts;
            }
            if (part === '..') {
                parts.pop();
                return parts;
            }
            parts.push(part);
            return parts;
        }, [])
        .join('/');
}

function stripBlobPath(path) {
    if (!path || !path.startsWith('blob:')) {
        return path;
    }

    const blobMatch = path.match(/^blob:https?:\/\/[^/]+\/(.+)$/);
    return blobMatch?.[1] || path;
}

function addCandidate(candidates, path) {
    if (!path) return;

    const withoutBlob = stripBlobPath(path);
    const normalized = normalizePath(withoutBlob);
    const cleaned = cleanFilePath(withoutBlob);

    [path, withoutBlob, normalized, cleaned].forEach(candidate => {
        if (candidate) {
            candidates.push(candidate);
        }
    });
}

function getUniqueFileByPredicate(fileMap, predicate) {
    let matchedFile = null;
    let matchCount = 0;

    for (const [key, file] of fileMap.entries()) {
        if (predicate(key)) {
            matchedFile = file;
            matchCount++;
        }
    }

    return matchCount === 1 ? matchedFile : null;
}

/**
 * Resolve a file from a path-keyed map without guessing among duplicate basenames.
 * Exact and normalized path matches are preferred; basename fallback is only used
 * when exactly one file matches.
 */
export function resolveFileFromMap(path, fileMap, options = {}) {
    if (!path || !fileMap) {
        return null;
    }

    const baseDir = options.baseDir || '';
    const candidates = [];
    const rawPath = stripBlobPath(path);

    addCandidate(candidates, rawPath);

    if (rawPath.startsWith('package://')) {
        const packagePath = rawPath.replace(/^package:\/\//, '');
        addCandidate(candidates, packagePath);

        const parts = packagePath.split('/');
        if (parts.length > 1) {
            addCandidate(candidates, parts.slice(1).join('/'));
        }
    }

    const normalizedPath = normalizePath(rawPath.replace(/^package:\/\//, ''));
    const normalizedParts = normalizedPath.split('/');
    if (normalizedParts.length > 1) {
        addCandidate(candidates, normalizedParts.slice(1).join('/'));
    }

    if (baseDir && normalizedPath && !normalizedPath.startsWith(baseDir)) {
        addCandidate(candidates, `${baseDir.replace(/[\\/]+$/, '')}/${normalizedPath}`);
        if (normalizedParts.length > 1) {
            addCandidate(candidates, `${baseDir.replace(/[\\/]+$/, '')}/${normalizedParts.slice(1).join('/')}`);
        }
    }

    for (const candidate of candidates) {
        if (fileMap.has(candidate)) {
            return fileMap.get(candidate);
        }
    }

    const normalizedCandidates = new Set(candidates.map(candidate => cleanFilePath(candidate)));
    const exactNormalizedMatch = getUniqueFileByPredicate(fileMap, key => (
        normalizedCandidates.has(cleanFilePath(key))
    ));
    if (exactNormalizedMatch) {
        return exactNormalizedMatch;
    }

    const lowerCandidates = new Set(Array.from(normalizedCandidates, candidate => candidate.toLowerCase()));
    const exactCaseInsensitiveMatch = getUniqueFileByPredicate(fileMap, key => (
        lowerCandidates.has(cleanFilePath(key).toLowerCase())
    ));
    if (exactCaseInsensitiveMatch) {
        return exactCaseInsensitiveMatch;
    }

    // Try suffixes from most to least specific. Checking every candidate in a
    // single predicate lets a broad fallback such as "meshes/base.dae" make a
    // package-qualified path such as "go2_description/meshes/base.dae" look
    // ambiguous when several robot packages share the same mesh basename.
    const orderedSuffixCandidates = Array.from(lowerCandidates)
        .filter(Boolean)
        .sort((a, b) => {
            const segmentDifference = b.split('/').length - a.split('/').length;
            return segmentDifference || b.length - a.length;
        });

    for (const candidate of orderedSuffixCandidates) {
        const suffixMatch = getUniqueFileByPredicate(fileMap, key => {
            const normalizedKey = cleanFilePath(key).toLowerCase();
            return normalizedKey === candidate || normalizedKey.endsWith('/' + candidate);
        });
        if (suffixMatch) {
            return suffixMatch;
        }
    }

    const fileName = cleanFilePath(rawPath).split('/').pop()?.toLowerCase();
    if (!fileName) {
        return null;
    }

    return getUniqueFileByPredicate(fileMap, key => (
        cleanFilePath(key).split('/').pop()?.toLowerCase() === fileName
    ));
}
