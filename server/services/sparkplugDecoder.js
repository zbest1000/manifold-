const protobuf = require('protobufjs');
const path = require('path');

class SparkplugDecoder {
  constructor() {
    this.root = null;
    this.Payload = null;
    this.initializeProtobuf();
  }

  async initializeProtobuf() {
    try {
      // Define Sparkplug B protobuf schema inline for simplicity
      const protoSchema = `
        syntax = "proto2";

        message Payload {
          optional uint64 timestamp = 1;
          repeated Metric metrics = 2;
          optional uint64 seq = 3;
          optional string uuid = 4;
          optional bytes body = 5;
        }

        message Metric {
          optional string name = 1;
          optional uint64 alias = 2;
          optional uint64 timestamp = 3;
          optional uint32 datatype = 4;
          optional bool is_historical = 5;
          optional bool is_transient = 6;
          optional bool is_null = 7;
          optional MetricValueExtension metadata = 8;
          optional PropertySet properties = 9;

          oneof value {
            uint32 int_value = 10;
            uint64 long_value = 11;
            float float_value = 12;
            double double_value = 13;
            bool boolean_value = 14;
            string string_value = 15;
            bytes bytes_value = 16;
            DataSet dataset_value = 17;
            Template template_value = 18;
            PropertySet extension_value = 19;
          }
        }

        message MetricValueExtension {
          optional bool is_multi_part = 1;
          optional string content_type = 2;
          optional uint64 size = 3;
          optional uint64 seq = 4;
          optional string file_name = 5;
          optional string file_type = 6;
          optional string md5 = 7;
          optional string description = 8;
        }

        message PropertySet {
          repeated string keys = 1;
          repeated PropertyValue values = 2;
        }

        message PropertyValue {
          optional uint32 type = 1;
          optional bool is_null = 2;

          oneof value {
            uint32 int_value = 3;
            uint64 long_value = 4;
            float float_value = 5;
            double double_value = 6;
            bool boolean_value = 7;
            string string_value = 8;
            PropertySet propertyset_value = 9;
            PropertySetList propertysets_value = 10;
          }
        }

        message PropertySetList {
          repeated PropertySet propertyset = 1;
        }

        message DataSet {
          optional uint64 num_of_columns = 1;
          repeated string columns = 2;
          repeated uint32 types = 3;
          repeated DataSetValue rows = 4;
        }

        message DataSetValue {
          repeated Variant elements = 1;
        }

        message Variant {
          oneof value {
            uint32 int_value = 1;
            uint64 long_value = 2;
            float float_value = 3;
            double double_value = 4;
            bool boolean_value = 5;
            string string_value = 6;
          }
        }

        message Template {
          optional string version = 1;
          repeated Metric metrics = 2;
          repeated Parameter parameters = 3;
          optional string template_ref = 4;
          optional bool is_definition = 5;
        }

        message Parameter {
          optional string name = 1;
          optional uint32 type = 2;

          oneof value {
            uint32 int_value = 3;
            uint64 long_value = 4;
            float float_value = 5;
            double double_value = 6;
            bool boolean_value = 7;
            string string_value = 8;
          }
        }
      `;

      // keepCase keeps proto field names snake_case (float_value, is_historical,
      // num_of_columns, ...) to match how the extractors below read them. Without
      // it protobufjs camelCases the names and every metric value / dataset /
      // template / historical flag silently decodes to null/undefined.
      this.root = protobuf.parse(protoSchema, { keepCase: true }).root;
      this.Payload = this.root.lookupType('Payload');
      
      console.log('✅ Sparkplug B protobuf schema initialized');
    } catch (error) {
      console.error('Failed to initialize Sparkplug protobuf schema:', error);
      throw error;
    }
  }

  decode(buffer) {
    if (!this.Payload) {
      throw new Error('Protobuf schema not initialized');
    }

    try {
      // Decode the protobuf message
      const message = this.Payload.decode(buffer);
      const object = this.Payload.toObject(message, {
        longs: String,
        enums: String,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });

      // Process and enhance the decoded payload
      return this.processSparkplugPayload(object);
    } catch (error) {
      console.error('Failed to decode Sparkplug payload:', error);
      throw error;
    }
  }

  processSparkplugPayload(payload) {
    const processed = {
      timestamp: payload.timestamp ? new Date(parseInt(payload.timestamp)) : null,
      seq: payload.seq,
      uuid: payload.uuid,
      body: payload.body,
      metrics: [],
      summary: {
        metricCount: 0,
        dataTypes: {},
        aliases: [],
        hasTemplate: false,
        hasDataset: false
      }
    };

    if (payload.metrics && Array.isArray(payload.metrics)) {
      processed.metrics = payload.metrics.map(metric => this.processMetric(metric));
      processed.summary.metricCount = processed.metrics.length;

      // Generate summary statistics
      processed.metrics.forEach(metric => {
        const dataType = this.getDataTypeName(metric.datatype);
        processed.summary.dataTypes[dataType] = (processed.summary.dataTypes[dataType] || 0) + 1;
        
        if (metric.alias) {
          processed.summary.aliases.push(metric.alias);
        }

        if (metric.template_value) {
          processed.summary.hasTemplate = true;
        }

        if (metric.dataset_value) {
          processed.summary.hasDataset = true;
        }
      });
    }

    return processed;
  }

  processMetric(metric) {
    const processed = {
      name: metric.name,
      alias: metric.alias,
      timestamp: metric.timestamp ? new Date(parseInt(metric.timestamp)) : null,
      datatype: metric.datatype,
      datatypeName: this.getDataTypeName(metric.datatype),
      isHistorical: metric.is_historical || false,
      isTransient: metric.is_transient || false,
      isNull: metric.is_null || false,
      value: this.extractMetricValue(metric),
      metadata: metric.metadata,
      properties: this.processPropertySet(metric.properties)
    };

    // Add human-readable description
    processed.description = this.generateMetricDescription(processed);

    return processed;
  }

  extractMetricValue(metric) {
    // Extract value based on the oneof field
    if (metric.int_value !== undefined) return metric.int_value;
    if (metric.long_value !== undefined) return metric.long_value;
    if (metric.float_value !== undefined) return metric.float_value;
    if (metric.double_value !== undefined) return metric.double_value;
    if (metric.boolean_value !== undefined) return metric.boolean_value;
    if (metric.string_value !== undefined) return metric.string_value;
    if (metric.bytes_value !== undefined) return metric.bytes_value;
    if (metric.dataset_value !== undefined) return this.processDataSet(metric.dataset_value);
    if (metric.template_value !== undefined) return this.processTemplate(metric.template_value);
    if (metric.extension_value !== undefined) return this.processPropertySet(metric.extension_value);

    return null;
  }

  processPropertySet(propertySet) {
    if (!propertySet || !propertySet.keys || !propertySet.values) {
      return {};
    }

    const result = {};
    for (let i = 0; i < propertySet.keys.length && i < propertySet.values.length; i++) {
      const key = propertySet.keys[i];
      const value = this.extractPropertyValue(propertySet.values[i]);
      result[key] = value;
    }

    return result;
  }

  extractPropertyValue(propertyValue) {
    if (propertyValue.is_null) return null;

    if (propertyValue.int_value !== undefined) return propertyValue.int_value;
    if (propertyValue.long_value !== undefined) return propertyValue.long_value;
    if (propertyValue.float_value !== undefined) return propertyValue.float_value;
    if (propertyValue.double_value !== undefined) return propertyValue.double_value;
    if (propertyValue.boolean_value !== undefined) return propertyValue.boolean_value;
    if (propertyValue.string_value !== undefined) return propertyValue.string_value;
    if (propertyValue.propertyset_value !== undefined) return this.processPropertySet(propertyValue.propertyset_value);

    return null;
  }

  processDataSet(dataset) {
    if (!dataset) return null;

    const processed = {
      numColumns: dataset.num_of_columns,
      columns: dataset.columns || [],
      types: dataset.types || [],
      rows: []
    };

    if (dataset.rows && Array.isArray(dataset.rows)) {
      processed.rows = dataset.rows.map(row => {
        if (row.elements && Array.isArray(row.elements)) {
          return row.elements.map(element => this.extractVariantValue(element));
        }
        return [];
      });
    }

    return processed;
  }

  extractVariantValue(variant) {
    if (variant.int_value !== undefined) return variant.int_value;
    if (variant.long_value !== undefined) return variant.long_value;
    if (variant.float_value !== undefined) return variant.float_value;
    if (variant.double_value !== undefined) return variant.double_value;
    if (variant.boolean_value !== undefined) return variant.boolean_value;
    if (variant.string_value !== undefined) return variant.string_value;

    return null;
  }

  processTemplate(template) {
    if (!template) return null;

    return {
      version: template.version,
      metrics: template.metrics ? template.metrics.map(m => this.processMetric(m)) : [],
      parameters: template.parameters || [],
      templateRef: template.template_ref,
      isDefinition: template.is_definition || false
    };
  }

  getDataTypeName(datatype) {
    const datatypes = {
      1: 'Int8',
      2: 'Int16', 
      3: 'Int32',
      4: 'Int64',
      5: 'UInt8',
      6: 'UInt16',
      7: 'UInt32',
      8: 'UInt64',
      9: 'Float',
      10: 'Double',
      11: 'Boolean',
      12: 'String',
      13: 'DateTime',
      14: 'Text',
      15: 'UUID',
      16: 'DataSet',
      17: 'Bytes',
      18: 'File',
      19: 'Template',
      20: 'PropertySet',
      21: 'PropertySetList'
    };

    return datatypes[datatype] || `Unknown(${datatype})`;
  }

  generateMetricDescription(metric) {
    const parts = [];

    if (metric.name) {
      parts.push(`"${metric.name}"`);
    }

    if (metric.alias) {
      parts.push(`(alias: ${metric.alias})`);
    }

    parts.push(`${metric.datatypeName}: ${this.formatValue(metric.value, metric.datatypeName)}`);

    if (metric.isHistorical) {
      parts.push('[Historical]');
    }

    if (metric.isTransient) {
      parts.push('[Transient]');
    }

    if (metric.isNull) {
      parts.push('[NULL]');
    }

    return parts.join(' ');
  }

  formatValue(value, dataType) {
    if (value === null || value === undefined) {
      return 'null';
    }

    switch (dataType) {
      case 'Boolean':
        return value ? 'true' : 'false';
      case 'Float':
      case 'Double':
        return typeof value === 'number' ? value.toFixed(2) : value.toString();
      case 'DateTime':
        return new Date(value).toISOString();
      case 'DataSet':
        return `DataSet(${value.rows ? value.rows.length : 0} rows)`;
      case 'Template':
        return `Template(${value.metrics ? value.metrics.length : 0} metrics)`;
      case 'Bytes':
        return `Bytes(${value.length || 0} bytes)`;
      default:
        return value.toString();
    }
  }

  // Static method to parse Sparkplug topic structure
  static parseSparkplugTopic(topic) {
    const parts = topic.split('/');

    if (parts[0] !== 'spBv1.0') {
      return null;
    }

    // Host application state: spBv1.0/STATE/{host_id} (Sparkplug 3.0 §STATE).
    // The host id is a single segment — anything deeper is not a valid STATE topic.
    if (parts[1] === 'STATE') {
      if (parts.length !== 3 || !parts[2]) return null;
      return {
        namespace: parts[0],
        groupId: null,
        messageType: 'STATE',
        messageTypeDescription: 'Host Application State',
        edgeNodeId: null,
        deviceId: null,
        hostId: parts[2]
      };
    }

    if (parts.length < 4) {
      return null;
    }

    const result = {
      namespace: parts[0], // spBv1.0
      groupId: parts[1],
      messageType: parts[2], // NBIRTH, DBIRTH, NDATA, DDATA, NDEATH, DDEATH
      edgeNodeId: parts[3],
      deviceId: parts.length > 4 ? parts.slice(4).join('/') : null
    };

    // Add human-readable message type description
    const messageTypes = {
      'NBIRTH': 'Node Birth Certificate',
      'DBIRTH': 'Device Birth Certificate', 
      'NDATA': 'Node Data',
      'DDATA': 'Device Data',
      'NDEATH': 'Node Death Certificate',
      'DDEATH': 'Device Death Certificate',
      'NCMD': 'Node Command',
      'DCMD': 'Device Command'
    };

    result.messageTypeDescription = messageTypes[result.messageType] || result.messageType;

    return result;
  }

  // Method to validate if a topic is Sparkplug B
  static isSparkplugBTopic(topic) {
    return topic.startsWith('spBv1.0/') && topic.split('/').length >= 4;
  }

  // Generate summary for multiple Sparkplug messages
  generateSessionSummary(messages) {
    const summary = {
      totalMessages: messages.length,
      messageTypes: {},
      groups: new Set(),
      edgeNodes: new Set(),
      devices: new Set(),
      metrics: new Set(),
      aliases: new Set(),
      timeRange: {
        start: null,
        end: null
      },
      dataTypes: {},
      birthCertificates: 0,
      deaths: 0
    };

    messages.forEach(msg => {
      if (msg.sparkplug) {
        const topicInfo = SparkplugDecoder.parseSparkplugTopic(msg.topic);
        
        if (topicInfo) {
          summary.messageTypes[topicInfo.messageType] = (summary.messageTypes[topicInfo.messageType] || 0) + 1;
          summary.groups.add(topicInfo.groupId);
          summary.edgeNodes.add(topicInfo.edgeNodeId);
          
          if (topicInfo.deviceId) {
            summary.devices.add(topicInfo.deviceId);
          }

          if (topicInfo.messageType.includes('BIRTH')) {
            summary.birthCertificates++;
          }

          if (topicInfo.messageType.includes('DEATH')) {
            summary.deaths++;
          }
        }

        if (msg.sparkplug.metrics) {
          msg.sparkplug.metrics.forEach(metric => {
            if (metric.name) summary.metrics.add(metric.name);
            if (metric.alias) summary.aliases.add(metric.alias);
            
            const dataType = metric.datatypeName;
            summary.dataTypes[dataType] = (summary.dataTypes[dataType] || 0) + 1;
          });
        }

        if (msg.sparkplug.timestamp) {
          const timestamp = new Date(msg.sparkplug.timestamp);
          if (!summary.timeRange.start || timestamp < summary.timeRange.start) {
            summary.timeRange.start = timestamp;
          }
          if (!summary.timeRange.end || timestamp > summary.timeRange.end) {
            summary.timeRange.end = timestamp;
          }
        }
      }
    });

    // Convert sets to arrays for JSON serialization
    summary.groups = Array.from(summary.groups);
    summary.edgeNodes = Array.from(summary.edgeNodes);
    summary.devices = Array.from(summary.devices);
    summary.metrics = Array.from(summary.metrics);
    summary.aliases = Array.from(summary.aliases);

    return summary;
  }
}

module.exports = SparkplugDecoder;