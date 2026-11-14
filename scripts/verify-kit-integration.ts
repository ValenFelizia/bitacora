import { resolve } from 'node:path';
import { verifyKitIntegration } from '../server/test/kit-integration';
console.log(await verifyKitIntegration(resolve('docs/verification/issue6/integration')));
