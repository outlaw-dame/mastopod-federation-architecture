import { GoogleVisionAdapter } from './googleVisionAdapter';
import { SafeBrowsingAdapter } from './safeBrowsingAdapter';
import { GoogleVideoAdapter } from './googleVideoAdapter';

export const safetyAdapters = [
  new SafeBrowsingAdapter(),
  new GoogleVisionAdapter(),
  new GoogleVideoAdapter()
];
