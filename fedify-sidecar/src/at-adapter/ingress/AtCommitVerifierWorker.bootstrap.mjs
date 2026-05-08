// Worker bootstrap: register tsx's ESM loader inside this worker thread via
// tsx's official API (which uses node's `--import`-style registration under
// the hood) and then dynamic-import the .ts worker entry. The older
// `register("tsx/esm", ...)` path is rejected by current tsx as the
// deprecated --loader flow.
import { register } from "tsx/esm/api";

register();

await import("./AtCommitVerifierWorker.ts");
