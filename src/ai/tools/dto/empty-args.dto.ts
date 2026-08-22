/** Shared arg shape for tools that take no arguments -- still validated
 * (via validateToolArgs) so an unexpected/extra property the model sends
 * is rejected with a clear error rather than silently ignored. */
export class EmptyArgsDto {}
