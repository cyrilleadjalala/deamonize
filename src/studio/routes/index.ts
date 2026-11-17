/** The default route registry. Owned by the foundation group: the other groups fill the route modules, not this list. */
import { compileRoutes } from './compile.js';
import { powerRoutes } from './power.js';
import { recordRoutes } from './record.js';
import { secretRoutes } from './secrets.js';
import { sessionRoutes } from './sessions.js';
import type { RouteFactory } from './types.js';

export const DEFAULT_ROUTES: RouteFactory[] = [recordRoutes, sessionRoutes, secretRoutes, compileRoutes, powerRoutes];