const filenameEncoder = new TextEncoder();

function fitFilename(text, limit) {
  let result = '', bytes = 0;
  for (const character of text) {
    bytes += filenameEncoder.encode(character).length;
    if (bytes > limit) break;
    result += character;
  }
  return result;
}

// Leave room for collision numbering within the common 255-byte filename limit.
export function safeName(name, number = 1) {
  const clean = name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'file';
  const prefix = number === 1 ? '' : `${number}-`;
  const limit = 255 - prefix.length;
  if (filenameEncoder.encode(clean).length <= limit) return prefix + clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? clean.slice(dot) : '';
  const stem = extension ? clean.slice(0, dot) : clean;
  const stemLimit = limit - filenameEncoder.encode(extension).length;
  // Keep the extension when it leaves room for at least the first full character.
  if (extension && filenameEncoder.encode([...stem][0]).length <= stemLimit) return prefix + fitFilename(stem, stemLimit) + extension;
  return prefix + fitFilename(clean, limit);
}

export function uniqueName(name, used) {
  let result = safeName(name), number = 2;
  // Two selected files can have the same name, including on case-insensitive disks.
  while (used.has(result.toLowerCase())) result = safeName(name, number++);
  used.add(result.toLowerCase());
  return result;
}
