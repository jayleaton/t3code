import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";

/**
 * The projects a scheduler test treats as hosted by this environment; by default every
 * project is. The scheduler only checks that the project exists here.
 */
export const layerLocalProjects = (isLocal: (projectId: ProjectId) => boolean = () => true) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      Effect.succeed(isLocal(projectId) ? Option.some({ id: projectId } as never) : Option.none()),
  });
