//! Closed, bounded data shapes with an explicit JSON Schema-compatible object profile.
//! Not a full JSON Schema validator: no executable code, remote refs or open objects.
//! These validate a Worker's declared result; they cannot prove work was done.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Shape {
    /// All declared properties are required; additional properties are rejected.
    Object {
        properties: BTreeMap<String, Shape>,
        /// Omit both fields only for the legacy all-required/closed shorthand.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        required: Option<Vec<String>>,
        #[serde(
            default,
            rename = "additionalProperties",
            skip_serializing_if = "Option::is_none"
        )]
        additional_properties: Option<bool>,
    },
    Array {
        items: Box<Shape>,
        #[serde(default, rename = "minItems")]
        min_items: usize,
        #[serde(rename = "maxItems")]
        max_items: usize,
    },
    String {
        #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
        values: Option<Vec<String>>,
        #[serde(default, rename = "minLength")]
        min_length: usize,
    },
    Integer,
    Boolean,
    Null,
}

impl Shape {
    pub(super) fn validate(&self) -> Result<()> {
        fn walk(shape: &Shape, depth: usize, remaining: &mut usize) -> Result<()> {
            if depth > 16 || *remaining == 0 {
                bail!("output shape exceeds depth/size limits");
            }
            *remaining -= 1;
            match shape {
                Shape::Object {
                    properties,
                    required,
                    additional_properties,
                } => {
                    if required.is_some() != additional_properties.is_some()
                        || additional_properties == &Some(true)
                    {
                        bail!("output object: declare both required and additionalProperties: false, or omit both for legacy shorthand");
                    }
                    if let Some(required) = required {
                        let unique: std::collections::BTreeSet<_> = required.iter().collect();
                        if unique.len() != required.len()
                            || required.iter().any(|k| !properties.contains_key(k))
                        {
                            bail!("output required must contain unique declared property names");
                        }
                    }
                    if properties.len() > 64
                        || properties.keys().any(|k| k.is_empty() || k.len() > 128)
                    {
                        bail!("output shape requires at most 64 bounded property names");
                    }
                    for value in properties.values() {
                        walk(value, depth + 1, remaining)?;
                    }
                }
                Shape::Array {
                    items,
                    min_items,
                    max_items,
                } => {
                    if min_items > max_items || *max_items > 4096 {
                        bail!("output array requires 0 <= minItems <= maxItems <= 4096");
                    }
                    walk(items, depth + 1, remaining)?;
                }
                Shape::String { values, min_length } => {
                    if *min_length > 16384
                        || values.as_ref().is_some_and(|v| {
                            v.is_empty()
                                || v.len() > 64
                                || v.iter()
                                    .any(|s| s.len() > 16384 || s.chars().count() < *min_length)
                        })
                    {
                        bail!("output string enum/minLength exceeds bounds");
                    }
                }
                _ => {}
            }
            Ok(())
        }
        walk(self, 0, &mut 512)
    }

    pub(super) fn verify(&self, value: &Value, path: &str) -> Result<()> {
        match (self, value) {
            (
                Self::Object {
                    properties,
                    required,
                    ..
                },
                Value::Object(values),
            ) => {
                let required: Vec<_> = required
                    .as_ref()
                    .map(|r| r.iter().collect())
                    .unwrap_or_else(|| properties.keys().collect());
                if values.keys().any(|k| !properties.contains_key(k))
                    || required.iter().any(|k| !values.contains_key(*k))
                {
                    bail!("output {path}: property set does not match its declared shape");
                }
                for (key, shape) in properties {
                    if let Some(value) = values.get(key) {
                        shape.verify(
                            value,
                            &format!("{path}/{}", workflow_engine::pointer_token(key)),
                        )?;
                    }
                }
            }
            (
                Self::Array {
                    items,
                    min_items,
                    max_items,
                },
                Value::Array(values),
            ) => {
                if values.len() < *min_items || values.len() > *max_items {
                    bail!("output {path}: array length is outside {min_items}..{max_items}");
                }
                for (i, value) in values.iter().enumerate() {
                    items.verify(value, &format!("{path}/{i}"))?;
                }
            }
            (Self::String { values, min_length }, Value::String(s)) => {
                if s.len() > 16384
                    || s.chars().count() < *min_length
                    || values.as_ref().is_some_and(|v| !v.contains(s))
                {
                    bail!("output {path}: string does not match its declared bounds/enum");
                }
            }
            (Self::Integer, Value::Number(n)) if n.is_i64() => {}
            (Self::Boolean, Value::Bool(_)) | (Self::Null, Value::Null) => {}
            _ => bail!("output {path}: value has the wrong type"),
        }
        Ok(())
    }
}

pub(super) fn bounded(value: &Value) -> Result<()> {
    fn walk(value: &Value, depth: usize, remaining: &mut usize) -> Result<()> {
        if depth > 32 || *remaining == 0 {
            bail!("output exceeds depth/value-count limits");
        }
        *remaining -= 1;
        match value {
            Value::Object(values) => {
                for v in values.values() {
                    walk(v, depth + 1, remaining)?;
                }
            }
            Value::Array(values) => {
                for v in values {
                    walk(v, depth + 1, remaining)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, 0, &mut 16384)?;
    if serde_json::to_vec(value)?.len() > MAX_OUTPUT_BYTES {
        bail!("output exceeds 256 KiB");
    }
    Ok(())
}
