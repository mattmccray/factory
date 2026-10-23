// Entry for the installed, self-contained CLI (`factory/cli.ts`), bundled by `bundle.ts`.
// Its factory root is its own directory, as for the vendored v0.
import { runCore } from './core';

process.exitCode = await runCore(process.argv.slice(2), {
  root: import.meta.dir,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
