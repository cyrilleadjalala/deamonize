/** The default route registry. Owned by the foundation group: the other groups fill the route modules, not this list. */
import { activityRoutes } from './activity.js';
import { approvalsRoutes } from './approvals.js';
import { compileRoutes } from './compile.js';
import { powerRoutes } from './power.js';
import { daemonizePowerRoutes } from './power-daemonize.js';
import { recordRoutes } from './record.js';
import { secretRoutes } from './secrets.js';
import { sessionRoutes } from './sessions.js';
import { systemRoutes } from './system.js';
import { workflowRoutes } from './workflows.js';
import type { RouteFactory } from './types.js';

export const DEFAULT_ROUTES: RouteFactory[] = [
    recordRoutes,
    sessionRoutes,
    secretRoutes,
    compileRoutes,
    powerRoutes,
    workflowRoutes,
    approvalsRoutes,
    activityRoutes,
    systemRoutes,
    daemonizePowerRoutes,
];
