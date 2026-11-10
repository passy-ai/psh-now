// Tiny demo service used to exercise the pshy approval flow.
export function greet(name = "world") {
  return `hello, ${name}`;
}

if (import.meta.main) {
  console.log(greet());
}