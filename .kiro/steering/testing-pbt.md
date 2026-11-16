---
inclusion: fileMatch
fileMatchPattern: ["**/*.test.ts", "src/pbt/**/*.ts", "src/validator/**/*.ts"]
---

# Testing and property-based tests

- Every correctness property in `design.md` has a test tagged `// Feature: daemonize, Property N: ...` with at least 100 runs.
- Use property tests for invariants (round-trip, idempotence, commutativity, "invalid input is never accepted"). Use unit tests for concrete examples and edge cases.
- Arbitraries must produce **schema-valid** inputs. Build them from the schema constraints, not from arbitrary strings.
- A counterexample found by fast-check is a bug until proven otherwise. Fix the code, or narrow the property only if the property contradicts the requirement. Record the reason in the task notes. Example: merge deduplicates transitions by a composite key, so two transitions with the same key and different ids correctly collapse to one.
- A generated invalid payload must be impossible to accept. If a schema keyword cannot be turned into a sound violation, refuse it with `UnsupportedSchemaError` and write a skipped test with the reason. Never approximate silently: a property that ignores a keyword passes without proving anything.
- Use temporary directories outside the workspace for compile tests, and clean them up.