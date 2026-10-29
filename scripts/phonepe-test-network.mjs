// CI tests must explicitly mock fetch. Never use merchant credentials or real services.
globalThis.fetch = async () => { throw new Error("Unmocked network request forbidden in PhonePe tests"); };
