
import { normalizeNepaliPhone } from "./phone.utils.js";
import { calculateSmsParts } from "./sms.utils.js";

console.log(normalizeNepaliPhone("+9779841234567"));

console.log(calculateSmsParts("Hello".repeat(40)));
console.log(calculateSmsParts("Hello".repeat(40) + "😊"));
console.log(calculateSmsParts("नमस्ते".repeat(20)));
