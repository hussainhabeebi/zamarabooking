// Tests replace fetch with local mock functions. An unmocked request must fail,
// never fall through to a supplier, payment gateway or production API.
globalThis.fetch = async () => { throw new Error("Unmocked network request forbidden in Akbar safety tests"); };
