
const absForward = "C:/Users/test";
const absBack = "C:\\Users\\test";

const regex = /^[a-zA-Z]:[\/]/;

console.log(`Path: ${absForward} -> Match: ${regex.test(absForward)}`);
console.log(`Path: ${absBack} -> Match: ${regex.test(absBack)}`);

const fixedRegex = /^[a-zA-Z]:[\\\/]/;
console.log(`Path: ${absForward} -> Fixed Match: ${fixedRegex.test(absForward)}`);
console.log(`Path: ${absBack} -> Fixed Match: ${fixedRegex.test(absBack)}`);
