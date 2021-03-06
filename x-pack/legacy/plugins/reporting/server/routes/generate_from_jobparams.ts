/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import boom from 'boom';
import Joi from 'joi';
import { Legacy } from 'kibana';
import rison from 'rison-node';
import { ReportingCore } from '../';
import { API_BASE_URL } from '../../common/constants';
import { LevelLogger as Logger } from '../lib';
import { ReportingSetupDeps, ServerFacade } from '../types';
import { makeRequestFacade } from './lib/make_request_facade';
import {
  GetRouteConfigFactoryFn,
  getRouteConfigFactoryReportingPre,
  RouteConfigFactory,
} from './lib/route_config_factories';
import { HandlerErrorFunction, HandlerFunction, ReportingResponseToolkit } from './types';

const BASE_GENERATE = `${API_BASE_URL}/generate`;

export function registerGenerateFromJobParams(
  reporting: ReportingCore,
  server: ServerFacade,
  plugins: ReportingSetupDeps,
  handler: HandlerFunction,
  handleError: HandlerErrorFunction,
  logger: Logger
) {
  const config = reporting.getConfig();
  const getRouteConfig = () => {
    const getOriginalRouteConfig: GetRouteConfigFactoryFn = getRouteConfigFactoryReportingPre(
      config,
      plugins,
      logger
    );
    const routeConfigFactory: RouteConfigFactory = getOriginalRouteConfig(
      ({ params: { exportType } }) => exportType
    );

    return {
      ...routeConfigFactory,
      validate: {
        params: Joi.object({
          exportType: Joi.string().required(),
        }).required(),
        payload: Joi.object({
          jobParams: Joi.string()
            .optional()
            .default(null),
        }).allow(null), // allow optional payload
        query: Joi.object({
          jobParams: Joi.string().default(null),
        }).default(),
      },
    };
  };

  // generate report
  server.route({
    path: `${BASE_GENERATE}/{exportType}`,
    method: 'POST',
    options: getRouteConfig(),
    handler: async (legacyRequest: Legacy.Request, h: ReportingResponseToolkit) => {
      const request = makeRequestFacade(legacyRequest);
      let jobParamsRison: string | null;

      if (request.payload) {
        const { jobParams: jobParamsPayload } = request.payload as { jobParams: string };
        jobParamsRison = jobParamsPayload;
      } else {
        const { jobParams: queryJobParams } = request.query as { jobParams: string };
        if (queryJobParams) {
          jobParamsRison = queryJobParams;
        } else {
          jobParamsRison = null;
        }
      }

      if (!jobParamsRison) {
        throw boom.badRequest('A jobParams RISON string is required');
      }

      const { exportType } = request.params;
      let jobParams;
      let response;
      try {
        jobParams = rison.decode(jobParamsRison) as object | null;
        if (!jobParams) {
          throw new Error('missing jobParams!');
        }
      } catch (err) {
        throw boom.badRequest(`invalid rison: ${jobParamsRison}`);
      }
      try {
        response = await handler(exportType, jobParams, legacyRequest, h);
      } catch (err) {
        throw handleError(exportType, err);
      }
      return response;
    },
  });

  // Get route to generation endpoint: show error about GET method to user
  server.route({
    path: `${BASE_GENERATE}/{p*}`,
    method: 'GET',
    handler: () => {
      const err = boom.methodNotAllowed('GET is not allowed');
      err.output.headers.allow = 'POST';
      return err;
    },
  });
}
