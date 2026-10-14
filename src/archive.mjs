import fs from 'node:fs';
// Standard ustar, streamed through gzip by the HTTP layer. No external commands.
function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  const oct = (value, start, length) => h.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
  oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(size, 124, 12); oct(0, 136, 12);
  h.fill(32, 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
export async function* tarFiles(files) {
  for (const file of files) {
    const size = fs.statSync(file.path).size; yield header(file.name, size);
    for await (const chunk of fs.createReadStream(file.path)) yield chunk;
    if (size % 512) yield Buffer.alloc(512 - size % 512);
  }
  yield Buffer.alloc(1024);
}
