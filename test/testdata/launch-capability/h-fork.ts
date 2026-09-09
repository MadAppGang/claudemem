/**
 * FIXTURE (h) — `fork`.
 *
 * Every export of `node:child_process` is a launch primitive; `fork` is the
 * one the original argument-shaped regex did not list. Kind `primitive`.
 */
import { fork } from "node:child_process";

export function startWorker(script: string): void {
	fork(script, [], { stdio: "ignore" });
}
