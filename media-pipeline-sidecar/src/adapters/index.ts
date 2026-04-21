import { GoogleVisionAdapter } from './googleVisionAdapter';
import { SafeBrowsingAdapter } from './safeBrowsingAdapter';
import { GoogleVideoAdapter } from './googleVideoAdapter';
import { PdqHashAdapter } from './pdqHashAdapter';

export const safetyAdapters = [
  new SafeBrowsingAdapter(),
  new GoogleVisionAdapter(),
  new GoogleVideoAdapter(),
  new PdqHashAdapter(),
];
