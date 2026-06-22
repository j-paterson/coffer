/** Raised when a posting set doesn't balance, or a gatekeeper precondition
 *  fails. The Python pipeline's matching error is `ledger.LedgerError`. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}
