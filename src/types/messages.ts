/** Serializable subset of FieldMeta the popup needs — DOM nodes can't cross the message channel. */
export interface PopupFieldInfo {
  id: string;
  label: string;
  hidden: boolean;
}

export interface GetFieldsMessage {
  type: 'GET_FIELDS';
}

export interface GetFieldsResponse {
  onIssuePage: boolean;
  issueTypeId: string;
  fields: PopupFieldInfo[];
}

export type ExtensionMessage = GetFieldsMessage;

export function isGetFieldsMessage(msg: ExtensionMessage): msg is GetFieldsMessage {
  return msg.type === 'GET_FIELDS';
}
