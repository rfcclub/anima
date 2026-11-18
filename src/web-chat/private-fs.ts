import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
/** A private store is never a static-file root. Reject aliases and unsafe preexisting entries. */
export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700
  )
    throw Error("unsafe private directory");
  return realpathSync(path);
}
export function privateFile(path: string): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o600 ||
    st.nlink !== 1
  )
    throw Error("unsafe private file");
}
