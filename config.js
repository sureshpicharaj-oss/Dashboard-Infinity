'use strict';

/**
 * Central configuration for the Infinity Dashboard.
 * All GAM SOAP/REST endpoint URLs, OAuth scopes, and shared constants live here
 * so individual modules never hard-code URLs or magic values.
 *
 * GAM SOAP API version: v202602. Bump this here when upgrading the API version.
 */

const GAM_REST_BASE = 'https://admanager.googleapis.com/v1';
const GAM_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/CreativeService';
const GAM_REPORT_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/ReportService';
const GAM_CREATIVESET_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/CreativeSetService';
const GAM_LICA_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/LineItemCreativeAssociationService';
const GAM_SOAP_NS = 'https://www.google.com/apis/ads/publisher/v202602';
const GAM_LINEITEM_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/LineItemService';
const GAM_CUSTOM_TARGETING_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/CustomTargetingService';
const GAM_INVENTORY_SOAP_ENDPOINT = 'https://ads.google.com/apis/ads/publisher/v202602/InventoryService';
const SCOPES = ['https://www.googleapis.com/auth/admanager'];

// Orders whose creatives are completely excluded from the dashboard
const EXCLUDED_ORDER_IDS = [3559958634];

// Custom targeting key names that hold VIDEO_IDs on video-hosting line items.
// GAM may use any of these depending on how the trafficker set up the line item.
const VIDEO_TARGETING_KEY_NAMES = ['infinityvideo', 'Video_Tracking', 'advertiser'];

module.exports = {
  GAM_REST_BASE,
  GAM_SOAP_ENDPOINT,
  GAM_REPORT_SOAP_ENDPOINT,
  GAM_CREATIVESET_SOAP_ENDPOINT,
  GAM_LICA_SOAP_ENDPOINT,
  GAM_SOAP_NS,
  GAM_LINEITEM_SOAP_ENDPOINT,
  GAM_CUSTOM_TARGETING_ENDPOINT,
  GAM_INVENTORY_SOAP_ENDPOINT,
  SCOPES,
  EXCLUDED_ORDER_IDS,
  VIDEO_TARGETING_KEY_NAMES,
};
