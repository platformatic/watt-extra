export interface FullResponse<T, U extends number> {
  'statusCode': U;
  'headers': object;
  'body': T;
}

export type GetReportsRequest = {
  query?: {
    /**
     * Limit will be applied by default if not passed. If the provided value exceeds the maximum allowed value a validation error will be thrown
     */
    'limit'?: number;
    'offset'?: number;
    'totalCount'?: boolean;
    /**
     * Include cursor headers in response. Cursor keys built from orderBy clause
     */
    'cursor'?: boolean;
    /**
     * Cursor for forward pagination. List objects after this cursor position
     */
    'startAfter'?: string;
    /**
     * Cursor for backward pagination. List objects before this cursor position
     */
    'endBefore'?: string;
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.result.eq'?: boolean;
    'where.result.neq'?: boolean;
    'where.result.gt'?: boolean;
    'where.result.gte'?: boolean;
    'where.result.lt'?: boolean;
    'where.result.lte'?: boolean;
    'where.result.like'?: boolean;
    'where.result.ilike'?: boolean;
    'where.result.in'?: string;
    'where.result.nin'?: string;
    'where.result.contains'?: string;
    'where.result.contained'?: string;
    'where.result.overlaps'?: string;
    'where.ruleSet.eq'?: string;
    'where.ruleSet.neq'?: string;
    'where.ruleSet.gt'?: string;
    'where.ruleSet.gte'?: string;
    'where.ruleSet.lt'?: string;
    'where.ruleSet.lte'?: string;
    'where.ruleSet.like'?: string;
    'where.ruleSet.ilike'?: string;
    'where.ruleSet.in'?: string;
    'where.ruleSet.nin'?: string;
    'where.ruleSet.contains'?: string;
    'where.ruleSet.contained'?: string;
    'where.ruleSet.overlaps'?: string;
    'where.or'?: Array<string>;
    'orderby.applicationId'?: 'asc' | 'desc';
    'orderby.createdAt'?: 'asc' | 'desc';
    'orderby.id'?: 'asc' | 'desc';
    'orderby.result'?: 'asc' | 'desc';
    'orderby.ruleSet'?: 'asc' | 'desc';
  }
}

/**
 * Default Response
 */
export type GetReportsResponseOK = Array<{ 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }>
export type GetReportsResponses =
  FullResponse<GetReportsResponseOK, 200>

export type CreateReportRequest = {
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
  }
  body: {
    'id'?: string;
    'applicationId'?: string | null;
    'result': boolean;
    'ruleSet': object;
    'createdAt'?: string | null;
  }
}

/**
 * A Report
 */
export type CreateReportResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }
export type CreateReportResponses =
  FullResponse<CreateReportResponseOK, 200>

export type UpdateReportsRequest = {
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.result.eq'?: boolean;
    'where.result.neq'?: boolean;
    'where.result.gt'?: boolean;
    'where.result.gte'?: boolean;
    'where.result.lt'?: boolean;
    'where.result.lte'?: boolean;
    'where.result.like'?: boolean;
    'where.result.ilike'?: boolean;
    'where.result.in'?: string;
    'where.result.nin'?: string;
    'where.result.contains'?: string;
    'where.result.contained'?: string;
    'where.result.overlaps'?: string;
    'where.ruleSet.eq'?: string;
    'where.ruleSet.neq'?: string;
    'where.ruleSet.gt'?: string;
    'where.ruleSet.gte'?: string;
    'where.ruleSet.lt'?: string;
    'where.ruleSet.lte'?: string;
    'where.ruleSet.like'?: string;
    'where.ruleSet.ilike'?: string;
    'where.ruleSet.in'?: string;
    'where.ruleSet.nin'?: string;
    'where.ruleSet.contains'?: string;
    'where.ruleSet.contained'?: string;
    'where.ruleSet.overlaps'?: string;
    'where.or'?: Array<string>;
  }
  body: {
    'id'?: string;
    'applicationId'?: string | null;
    'result': boolean;
    'ruleSet': object;
    'createdAt'?: string | null;
  }
}

/**
 * Default Response
 */
export type UpdateReportsResponseOK = Array<{ 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }>
export type UpdateReportsResponses =
  FullResponse<UpdateReportsResponseOK, 200>

export type GetReportByIdRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
  }
}

/**
 * A Report
 */
export type GetReportByIdResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }
export type GetReportByIdResponses =
  FullResponse<GetReportByIdResponseOK, 200>

export type UpdateReportRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
  }
  body: {
    'applicationId'?: string | null;
    'result': boolean;
    'ruleSet': object;
    'createdAt'?: string | null;
  }
}

/**
 * A Report
 */
export type UpdateReportResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }
export type UpdateReportResponses =
  FullResponse<UpdateReportResponseOK, 200>

export type DeleteReportsRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'id' | 'result' | 'ruleSet'>;
  }
}

/**
 * A Report
 */
export type DeleteReportsResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'result'?: boolean | null; 'ruleSet'?: object | null; 'createdAt'?: string | null }
export type DeleteReportsResponses =
  FullResponse<DeleteReportsResponseOK, 200>

export type CreateRuleRequest = {
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
  }
  body: {
    'id'?: string;
    'name'?: string | null;
    'description'?: string | null;
    'label'?: string | null;
    'config': object;
    'createdAt'?: string | null;
  }
}

/**
 * A Rule
 */
export type CreateRuleResponseOK = { 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }
export type CreateRuleResponses =
  FullResponse<CreateRuleResponseOK, 200>

export type UpdateRulesRequest = {
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
    'where.config.eq'?: string;
    'where.config.neq'?: string;
    'where.config.gt'?: string;
    'where.config.gte'?: string;
    'where.config.lt'?: string;
    'where.config.lte'?: string;
    'where.config.like'?: string;
    'where.config.ilike'?: string;
    'where.config.in'?: string;
    'where.config.nin'?: string;
    'where.config.contains'?: string;
    'where.config.contained'?: string;
    'where.config.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.description.eq'?: string;
    'where.description.neq'?: string;
    'where.description.gt'?: string;
    'where.description.gte'?: string;
    'where.description.lt'?: string;
    'where.description.lte'?: string;
    'where.description.like'?: string;
    'where.description.ilike'?: string;
    'where.description.in'?: string;
    'where.description.nin'?: string;
    'where.description.contains'?: string;
    'where.description.contained'?: string;
    'where.description.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.label.eq'?: string;
    'where.label.neq'?: string;
    'where.label.gt'?: string;
    'where.label.gte'?: string;
    'where.label.lt'?: string;
    'where.label.lte'?: string;
    'where.label.like'?: string;
    'where.label.ilike'?: string;
    'where.label.in'?: string;
    'where.label.nin'?: string;
    'where.label.contains'?: string;
    'where.label.contained'?: string;
    'where.label.overlaps'?: string;
    'where.name.eq'?: string;
    'where.name.neq'?: string;
    'where.name.gt'?: string;
    'where.name.gte'?: string;
    'where.name.lt'?: string;
    'where.name.lte'?: string;
    'where.name.like'?: string;
    'where.name.ilike'?: string;
    'where.name.in'?: string;
    'where.name.nin'?: string;
    'where.name.contains'?: string;
    'where.name.contained'?: string;
    'where.name.overlaps'?: string;
    'where.or'?: Array<string>;
  }
  body: {
    'id'?: string;
    'name'?: string | null;
    'description'?: string | null;
    'label'?: string | null;
    'config': object;
    'createdAt'?: string | null;
  }
}

/**
 * Default Response
 */
export type UpdateRulesResponseOK = Array<{ 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }>
export type UpdateRulesResponses =
  FullResponse<UpdateRulesResponseOK, 200>

export type GetRuleByIdRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
  }
}

/**
 * A Rule
 */
export type GetRuleByIdResponseOK = { 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }
export type GetRuleByIdResponses =
  FullResponse<GetRuleByIdResponseOK, 200>

export type UpdateRuleRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
  }
  body: {
    'name'?: string | null;
    'description'?: string | null;
    'label'?: string | null;
    'config': object;
    'createdAt'?: string | null;
  }
}

/**
 * A Rule
 */
export type UpdateRuleResponseOK = { 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }
export type UpdateRuleResponses =
  FullResponse<UpdateRuleResponseOK, 200>

export type DeleteRulesRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
  }
}

/**
 * A Rule
 */
export type DeleteRulesResponseOK = { 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }
export type DeleteRulesResponses =
  FullResponse<DeleteRulesResponseOK, 200>

export type GetRuleConfigsForRuleRequest = {
  path: {
    'id': string;
  }
  query?: {
    /**
     * Limit will be applied by default if not passed. If the provided value exceeds the maximum allowed value a validation error will be thrown
     */
    'limit'?: number;
    'offset'?: number;
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
    'totalCount'?: boolean;
  }
}

/**
 * Default Response
 */
export type GetRuleConfigsForRuleResponseOK = Array<{ 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }>
export type GetRuleConfigsForRuleResponses =
  FullResponse<GetRuleConfigsForRuleResponseOK, 200>

export type GetRuleConfigsRequest = {
  query?: {
    /**
     * Limit will be applied by default if not passed. If the provided value exceeds the maximum allowed value a validation error will be thrown
     */
    'limit'?: number;
    'offset'?: number;
    'totalCount'?: boolean;
    /**
     * Include cursor headers in response. Cursor keys built from orderBy clause
     */
    'cursor'?: boolean;
    /**
     * Cursor for forward pagination. List objects after this cursor position
     */
    'startAfter'?: string;
    /**
     * Cursor for backward pagination. List objects before this cursor position
     */
    'endBefore'?: string;
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.enabled.eq'?: boolean;
    'where.enabled.neq'?: boolean;
    'where.enabled.gt'?: boolean;
    'where.enabled.gte'?: boolean;
    'where.enabled.lt'?: boolean;
    'where.enabled.lte'?: boolean;
    'where.enabled.like'?: boolean;
    'where.enabled.ilike'?: boolean;
    'where.enabled.in'?: string;
    'where.enabled.nin'?: string;
    'where.enabled.contains'?: string;
    'where.enabled.contained'?: string;
    'where.enabled.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.options.eq'?: string;
    'where.options.neq'?: string;
    'where.options.gt'?: string;
    'where.options.gte'?: string;
    'where.options.lt'?: string;
    'where.options.lte'?: string;
    'where.options.like'?: string;
    'where.options.ilike'?: string;
    'where.options.in'?: string;
    'where.options.nin'?: string;
    'where.options.contains'?: string;
    'where.options.contained'?: string;
    'where.options.overlaps'?: string;
    'where.ruleId.eq'?: string;
    'where.ruleId.neq'?: string;
    'where.ruleId.gt'?: string;
    'where.ruleId.gte'?: string;
    'where.ruleId.lt'?: string;
    'where.ruleId.lte'?: string;
    'where.ruleId.like'?: string;
    'where.ruleId.ilike'?: string;
    'where.ruleId.in'?: string;
    'where.ruleId.nin'?: string;
    'where.ruleId.contains'?: string;
    'where.ruleId.contained'?: string;
    'where.ruleId.overlaps'?: string;
    'where.type.eq'?: 'global' | 'local';
    'where.type.neq'?: 'global' | 'local';
    'where.type.gt'?: 'global' | 'local';
    'where.type.gte'?: 'global' | 'local';
    'where.type.lt'?: 'global' | 'local';
    'where.type.lte'?: 'global' | 'local';
    'where.type.like'?: 'global' | 'local';
    'where.type.ilike'?: 'global' | 'local';
    'where.type.in'?: string;
    'where.type.nin'?: string;
    'where.type.contains'?: string;
    'where.type.contained'?: string;
    'where.type.overlaps'?: string;
    'where.or'?: Array<string>;
    'orderby.applicationId'?: 'asc' | 'desc';
    'orderby.createdAt'?: 'asc' | 'desc';
    'orderby.enabled'?: 'asc' | 'desc';
    'orderby.id'?: 'asc' | 'desc';
    'orderby.options'?: 'asc' | 'desc';
    'orderby.ruleId'?: 'asc' | 'desc';
    'orderby.type'?: 'asc' | 'desc';
  }
}

/**
 * Default Response
 */
export type GetRuleConfigsResponseOK = Array<{ 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }>
export type GetRuleConfigsResponses =
  FullResponse<GetRuleConfigsResponseOK, 200>

export type CreateRuleConfigRequest = {
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
  }
  body: {
    'id'?: string;
    'type': 'global' | 'local';
    'applicationId'?: string | null;
    'enabled'?: boolean | null;
    'ruleId': string;
    'options': object;
    'createdAt'?: string | null;
  }
}

/**
 * A RuleConfig
 */
export type CreateRuleConfigResponseOK = { 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }
export type CreateRuleConfigResponses =
  FullResponse<CreateRuleConfigResponseOK, 200>

export type UpdateRuleConfigsRequest = {
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.enabled.eq'?: boolean;
    'where.enabled.neq'?: boolean;
    'where.enabled.gt'?: boolean;
    'where.enabled.gte'?: boolean;
    'where.enabled.lt'?: boolean;
    'where.enabled.lte'?: boolean;
    'where.enabled.like'?: boolean;
    'where.enabled.ilike'?: boolean;
    'where.enabled.in'?: string;
    'where.enabled.nin'?: string;
    'where.enabled.contains'?: string;
    'where.enabled.contained'?: string;
    'where.enabled.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.options.eq'?: string;
    'where.options.neq'?: string;
    'where.options.gt'?: string;
    'where.options.gte'?: string;
    'where.options.lt'?: string;
    'where.options.lte'?: string;
    'where.options.like'?: string;
    'where.options.ilike'?: string;
    'where.options.in'?: string;
    'where.options.nin'?: string;
    'where.options.contains'?: string;
    'where.options.contained'?: string;
    'where.options.overlaps'?: string;
    'where.ruleId.eq'?: string;
    'where.ruleId.neq'?: string;
    'where.ruleId.gt'?: string;
    'where.ruleId.gte'?: string;
    'where.ruleId.lt'?: string;
    'where.ruleId.lte'?: string;
    'where.ruleId.like'?: string;
    'where.ruleId.ilike'?: string;
    'where.ruleId.in'?: string;
    'where.ruleId.nin'?: string;
    'where.ruleId.contains'?: string;
    'where.ruleId.contained'?: string;
    'where.ruleId.overlaps'?: string;
    'where.type.eq'?: 'global' | 'local';
    'where.type.neq'?: 'global' | 'local';
    'where.type.gt'?: 'global' | 'local';
    'where.type.gte'?: 'global' | 'local';
    'where.type.lt'?: 'global' | 'local';
    'where.type.lte'?: 'global' | 'local';
    'where.type.like'?: 'global' | 'local';
    'where.type.ilike'?: 'global' | 'local';
    'where.type.in'?: string;
    'where.type.nin'?: string;
    'where.type.contains'?: string;
    'where.type.contained'?: string;
    'where.type.overlaps'?: string;
    'where.or'?: Array<string>;
  }
  body: {
    'id'?: string;
    'type': 'global' | 'local';
    'applicationId'?: string | null;
    'enabled'?: boolean | null;
    'ruleId': string;
    'options': object;
    'createdAt'?: string | null;
  }
}

/**
 * Default Response
 */
export type UpdateRuleConfigsResponseOK = Array<{ 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }>
export type UpdateRuleConfigsResponses =
  FullResponse<UpdateRuleConfigsResponseOK, 200>

export type GetRuleConfigByIdRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
  }
}

/**
 * A RuleConfig
 */
export type GetRuleConfigByIdResponseOK = { 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }
export type GetRuleConfigByIdResponses =
  FullResponse<GetRuleConfigByIdResponseOK, 200>

export type UpdateRuleConfigRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
  }
  body: {
    'type': 'global' | 'local';
    'applicationId'?: string | null;
    'enabled'?: boolean | null;
    'ruleId': string;
    'options': object;
    'createdAt'?: string | null;
  }
}

/**
 * A RuleConfig
 */
export type UpdateRuleConfigResponseOK = { 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }
export type UpdateRuleConfigResponses =
  FullResponse<UpdateRuleConfigResponseOK, 200>

export type DeleteRuleConfigsRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'enabled' | 'id' | 'options' | 'ruleId' | 'type'>;
  }
}

/**
 * A RuleConfig
 */
export type DeleteRuleConfigsResponseOK = { 'id'?: string | null; 'type'?: 'global' | 'local' | null; 'applicationId'?: string | null; 'enabled'?: boolean | null; 'ruleId'?: string | null; 'options'?: object | null; 'createdAt'?: string | null }
export type DeleteRuleConfigsResponses =
  FullResponse<DeleteRuleConfigsResponseOK, 200>

export type GetRuleForRuleConfigRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'config' | 'createdAt' | 'description' | 'id' | 'label' | 'name'>;
  }
}

/**
 * A Rule
 */
export type GetRuleForRuleConfigResponseOK = { 'id'?: string | null; 'name'?: string | null; 'description'?: string | null; 'label'?: string | null; 'config'?: object | null; 'createdAt'?: string | null }
export type GetRuleForRuleConfigResponses =
  FullResponse<GetRuleForRuleConfigResponseOK, 200>

export type GetMetadataRequest = {
  query?: {
    /**
     * Limit will be applied by default if not passed. If the provided value exceeds the maximum allowed value a validation error will be thrown
     */
    'limit'?: number;
    'offset'?: number;
    'totalCount'?: boolean;
    /**
     * Include cursor headers in response. Cursor keys built from orderBy clause
     */
    'cursor'?: boolean;
    /**
     * Cursor for forward pagination. List objects after this cursor position
     */
    'startAfter'?: string;
    /**
     * Cursor for backward pagination. List objects before this cursor position
     */
    'endBefore'?: string;
    'fields'?: Array<'applicationId' | 'createdAt' | 'data' | 'id'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.data.eq'?: string;
    'where.data.neq'?: string;
    'where.data.gt'?: string;
    'where.data.gte'?: string;
    'where.data.lt'?: string;
    'where.data.lte'?: string;
    'where.data.like'?: string;
    'where.data.ilike'?: string;
    'where.data.in'?: string;
    'where.data.nin'?: string;
    'where.data.contains'?: string;
    'where.data.contained'?: string;
    'where.data.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.or'?: Array<string>;
    'orderby.applicationId'?: 'asc' | 'desc';
    'orderby.createdAt'?: 'asc' | 'desc';
    'orderby.data'?: 'asc' | 'desc';
    'orderby.id'?: 'asc' | 'desc';
  }
}

/**
 * Default Response
 */
export type GetMetadataResponseOK = Array<{ 'id'?: string | null; 'applicationId'?: string | null; 'data'?: object | null; 'createdAt'?: string | null }>
export type GetMetadataResponses =
  FullResponse<GetMetadataResponseOK, 200>

export type UpdateMetadataRequest = {
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'data' | 'id'>;
    'where.applicationId.eq'?: string;
    'where.applicationId.neq'?: string;
    'where.applicationId.gt'?: string;
    'where.applicationId.gte'?: string;
    'where.applicationId.lt'?: string;
    'where.applicationId.lte'?: string;
    'where.applicationId.like'?: string;
    'where.applicationId.ilike'?: string;
    'where.applicationId.in'?: string;
    'where.applicationId.nin'?: string;
    'where.applicationId.contains'?: string;
    'where.applicationId.contained'?: string;
    'where.applicationId.overlaps'?: string;
    'where.createdAt.eq'?: string;
    'where.createdAt.neq'?: string;
    'where.createdAt.gt'?: string;
    'where.createdAt.gte'?: string;
    'where.createdAt.lt'?: string;
    'where.createdAt.lte'?: string;
    'where.createdAt.like'?: string;
    'where.createdAt.ilike'?: string;
    'where.createdAt.in'?: string;
    'where.createdAt.nin'?: string;
    'where.createdAt.contains'?: string;
    'where.createdAt.contained'?: string;
    'where.createdAt.overlaps'?: string;
    'where.data.eq'?: string;
    'where.data.neq'?: string;
    'where.data.gt'?: string;
    'where.data.gte'?: string;
    'where.data.lt'?: string;
    'where.data.lte'?: string;
    'where.data.like'?: string;
    'where.data.ilike'?: string;
    'where.data.in'?: string;
    'where.data.nin'?: string;
    'where.data.contains'?: string;
    'where.data.contained'?: string;
    'where.data.overlaps'?: string;
    'where.id.eq'?: string;
    'where.id.neq'?: string;
    'where.id.gt'?: string;
    'where.id.gte'?: string;
    'where.id.lt'?: string;
    'where.id.lte'?: string;
    'where.id.like'?: string;
    'where.id.ilike'?: string;
    'where.id.in'?: string;
    'where.id.nin'?: string;
    'where.id.contains'?: string;
    'where.id.contained'?: string;
    'where.id.overlaps'?: string;
    'where.or'?: Array<string>;
  }
  body: {
    'id'?: string;
    'applicationId'?: string | null;
    'data': object;
    'createdAt'?: string | null;
  }
}

/**
 * Default Response
 */
export type UpdateMetadataResponseOK = Array<{ 'id'?: string | null; 'applicationId'?: string | null; 'data'?: object | null; 'createdAt'?: string | null }>
export type UpdateMetadataResponses =
  FullResponse<UpdateMetadataResponseOK, 200>

export type GetMetadatumByIdRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'data' | 'id'>;
  }
}

/**
 * A Metadatum
 */
export type GetMetadatumByIdResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'data'?: object | null; 'createdAt'?: string | null }
export type GetMetadatumByIdResponses =
  FullResponse<GetMetadatumByIdResponseOK, 200>

export type UpdateMetadatumRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'data' | 'id'>;
  }
  body: {
    'applicationId'?: string | null;
    'data': object;
    'createdAt'?: string | null;
  }
}

/**
 * A Metadatum
 */
export type UpdateMetadatumResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'data'?: object | null; 'createdAt'?: string | null }
export type UpdateMetadatumResponses =
  FullResponse<UpdateMetadatumResponseOK, 200>

export type DeleteMetadataRequest = {
  path: {
    'id': string;
  }
  query?: {
    'fields'?: Array<'applicationId' | 'createdAt' | 'data' | 'id'>;
  }
}

/**
 * A Metadatum
 */
export type DeleteMetadataResponseOK = { 'id'?: string | null; 'applicationId'?: string | null; 'data'?: object | null; 'createdAt'?: string | null }
export type DeleteMetadataResponses =
  FullResponse<DeleteMetadataResponseOK, 200>

export type PostComplianceRequest = {
  body: {
    'applicationId': string;
    'podId': string;
  }
}

export type PostComplianceResponseOK = unknown
export type PostComplianceResponses =
  FullResponse<PostComplianceResponseOK, 200>

export type PostMetadataRequest = {
  body: {
    'applicationId': string;
    'podId': string;
    'data': object;
  }
}

export type PostMetadataResponseOK = unknown
export type PostMetadataResponses =
  FullResponse<PostMetadataResponseOK, 200>

export type PostRulesNameRequest = {
  path: {
    'name': string;
  }
  body: {
    'applicationId': string;
    'enabled': boolean;
    'options': object;
  }
}

export type PostRulesNameResponseOK = unknown
export type PostRulesNameResponses =
  FullResponse<PostRulesNameResponseOK, 200>

export type GetRulesRequest = {
  
}

export type GetRulesResponseOK = unknown
export type GetRulesResponses =
  FullResponse<GetRulesResponseOK, 200>



export interface Compliance {
  setBaseUrl(newUrl: string): void;
  setDefaultHeaders(headers: object): void;
  setDefaultFetchParams(fetchParams: RequestInit): void;
  /**
   * Get reports.
   *
   * Fetch reports from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getReports(req: GetReportsRequest): Promise<GetReportsResponses>;
  /**
   * Create report.
   *
   * Add new report to the database.
   * @param req - request parameters object
   * @returns the API response
   */
  createReport(req: CreateReportRequest): Promise<CreateReportResponses>;
  /**
   * Update reports.
   *
   * Update one or more reports in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateReports(req: UpdateReportsRequest): Promise<UpdateReportsResponses>;
  /**
   * Get Report by id.
   *
   * Fetch Report using its id from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getReportById(req: GetReportByIdRequest): Promise<GetReportByIdResponses>;
  /**
   * Update report.
   *
   * Update report in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateReport(req: UpdateReportRequest): Promise<UpdateReportResponses>;
  /**
   * Delete reports.
   *
   * Delete one or more reports from the Database.
   * @param req - request parameters object
   * @returns the API response
   */
  deleteReports(req: DeleteReportsRequest): Promise<DeleteReportsResponses>;
  /**
   * Create rule.
   *
   * Add new rule to the database.
   * @param req - request parameters object
   * @returns the API response
   */
  createRule(req: CreateRuleRequest): Promise<CreateRuleResponses>;
  /**
   * Update rules.
   *
   * Update one or more rules in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateRules(req: UpdateRulesRequest): Promise<UpdateRulesResponses>;
  /**
   * Get Rule by id.
   *
   * Fetch Rule using its id from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getRuleById(req: GetRuleByIdRequest): Promise<GetRuleByIdResponses>;
  /**
   * Update rule.
   *
   * Update rule in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateRule(req: UpdateRuleRequest): Promise<UpdateRuleResponses>;
  /**
   * Delete rules.
   *
   * Delete one or more rules from the Database.
   * @param req - request parameters object
   * @returns the API response
   */
  deleteRules(req: DeleteRulesRequest): Promise<DeleteRulesResponses>;
  /**
   * Get ruleConfigs for rule.
   *
   * Fetch all the ruleConfigs for rule from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getRuleConfigsForRule(req: GetRuleConfigsForRuleRequest): Promise<GetRuleConfigsForRuleResponses>;
  /**
   * Get ruleConfigs.
   *
   * Fetch ruleConfigs from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getRuleConfigs(req: GetRuleConfigsRequest): Promise<GetRuleConfigsResponses>;
  /**
   * Create ruleConfig.
   *
   * Add new ruleConfig to the database.
   * @param req - request parameters object
   * @returns the API response
   */
  createRuleConfig(req: CreateRuleConfigRequest): Promise<CreateRuleConfigResponses>;
  /**
   * Update ruleConfigs.
   *
   * Update one or more ruleConfigs in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateRuleConfigs(req: UpdateRuleConfigsRequest): Promise<UpdateRuleConfigsResponses>;
  /**
   * Get RuleConfig by id.
   *
   * Fetch RuleConfig using its id from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getRuleConfigById(req: GetRuleConfigByIdRequest): Promise<GetRuleConfigByIdResponses>;
  /**
   * Update ruleConfig.
   *
   * Update ruleConfig in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateRuleConfig(req: UpdateRuleConfigRequest): Promise<UpdateRuleConfigResponses>;
  /**
   * Delete ruleConfigs.
   *
   * Delete one or more ruleConfigs from the Database.
   * @param req - request parameters object
   * @returns the API response
   */
  deleteRuleConfigs(req: DeleteRuleConfigsRequest): Promise<DeleteRuleConfigsResponses>;
  /**
   * Get rule for ruleConfig.
   *
   * Fetch the rule for ruleConfig from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getRuleForRuleConfig(req: GetRuleForRuleConfigRequest): Promise<GetRuleForRuleConfigResponses>;
  /**
   * Get metadata.
   *
   * Fetch metadata from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getMetadata(req: GetMetadataRequest): Promise<GetMetadataResponses>;
  /**
   * Update metadata.
   *
   * Update one or more metadata in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateMetadata(req: UpdateMetadataRequest): Promise<UpdateMetadataResponses>;
  /**
   * Get Metadatum by id.
   *
   * Fetch Metadatum using its id from the database.
   * @param req - request parameters object
   * @returns the API response
   */
  getMetadatumById(req: GetMetadatumByIdRequest): Promise<GetMetadatumByIdResponses>;
  /**
   * Update metadatum.
   *
   * Update metadatum in the database.
   * @param req - request parameters object
   * @returns the API response
   */
  updateMetadatum(req: UpdateMetadatumRequest): Promise<UpdateMetadatumResponses>;
  /**
   * Delete metadata.
   *
   * Delete one or more metadata from the Database.
   * @param req - request parameters object
   * @returns the API response
   */
  deleteMetadata(req: DeleteMetadataRequest): Promise<DeleteMetadataResponses>;
  /**
   * @param req - request parameters object
   * @returns the API response
   */
  postCompliance(req: PostComplianceRequest): Promise<PostComplianceResponses>;
  /**
   * @param req - request parameters object
   * @returns the API response
   */
  postMetadata(req: PostMetadataRequest): Promise<PostMetadataResponses>;
  /**
   * @param req - request parameters object
   * @returns the API response
   */
  postRulesName(req: PostRulesNameRequest): Promise<PostRulesNameResponses>;
  /**
   * @param req - request parameters object
   * @returns the API response
   */
  getRules(req: GetRulesRequest): Promise<GetRulesResponses>;
}
type PlatformaticFrontendClient = Omit<Compliance, 'setBaseUrl'>
type BuildOptions = {
  headers?: object
}
export default function build(url: string, options?: BuildOptions): PlatformaticFrontendClient
