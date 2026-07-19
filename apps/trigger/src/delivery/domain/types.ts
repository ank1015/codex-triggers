import type {
  JsonSchema,
  JsonValue,
  Notification,
} from "../../domain/types.js";

export type Delivery = {
  id: string;
  name: string;
  triggerId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryTarget = {
  id: string;
  deliveryId: string;
  type: string;
  config: Record<string, JsonValue>;
  input: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryDetails = {
  delivery: Delivery;
  services: DeliveryTarget[];
};

export type DeliveryJobStatus = "queued" | "running" | "succeeded" | "failed";

export type DeliveryJob = {
  id: string;
  deliveryId: string;
  configuredServiceId: string;
  notificationId: string;
  serviceType: string;
  config: Record<string, JsonValue>;
  input: Record<string, JsonValue>;
  status: DeliveryJobStatus;
  result: JsonValue | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ConfiguredDeliveryServiceInput = {
  type: string;
  config: Record<string, JsonValue>;
  input: Record<string, JsonValue>;
};

export type CreateDeliveryInput = {
  name: string;
  triggerId: string;
  enabled: boolean;
  services: ConfiguredDeliveryServiceInput[];
};

export type UpdateDeliveryInput = {
  name?: string;
  enabled?: boolean;
  services?: ConfiguredDeliveryServiceInput[];
};

export type DeliveryServiceDescriptor = {
  type: string;
  configSchema: JsonSchema;
  inputSchema: JsonSchema;
};

export type DeliveryServiceRequest = {
  configuredServiceId: string;
  config: Record<string, JsonValue>;
  input: Record<string, JsonValue>;
  notification: Notification;
  signal: AbortSignal;
  updateConfig(config: Record<string, JsonValue>): void;
};

export type DeliveryService = DeliveryServiceDescriptor & {
  deliver(request: DeliveryServiceRequest): Promise<JsonValue | void>;
  stop?(): Promise<void>;
};
