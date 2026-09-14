use crate::{Error, Expr, Result};
use serde_json::Value;
impl Expr {
    pub fn evaluate(&self, context: &Value) -> Result<Value> {
        Ok(match self {
            Self::Literal { value } => value.clone(),
            Self::Ref { path } => context
                .pointer(path)
                .cloned()
                .ok_or_else(|| Error::Condition(format!("missing reference {path}")))?,
            Self::Exists { path } => Value::Bool(context.pointer(path).is_some()),
            Self::Object { fields } => Value::Object(
                fields
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), v.evaluate(context)?)))
                    .collect::<Result<_>>()?,
            ),
            Self::Eq { left, right } => {
                let l = left.evaluate(context)?;
                let r = right.evaluate(context)?;
                if std::mem::discriminant(&l) != std::mem::discriminant(&r) {
                    return Err(Error::Condition("equality requires matching types".into()));
                }
                Value::Bool(l == r)
            }
            Self::Lt { left, right } => {
                let l = left.evaluate(context)?;
                let r = right.evaluate(context)?;
                let pair = l.as_i64().zip(r.as_i64());
                let less = if let Some((a, b)) = pair {
                    a < b
                } else if let Some((a, b)) = l.as_u64().zip(r.as_u64()) {
                    a < b
                } else {
                    return Err(Error::Condition("lt requires same-range integers".into()));
                };
                Value::Bool(less)
            }
            Self::Add { left, right } => {
                let a = left.evaluate(context)?;
                let b = right.evaluate(context)?;
                let sum = a
                    .as_i64()
                    .zip(b.as_i64())
                    .and_then(|(a, b)| a.checked_add(b))
                    .ok_or_else(|| {
                        Error::Condition("add requires integers without i64 overflow".into())
                    })?;
                Value::from(sum)
            }
            Self::Append { array, value } => {
                let mut items = array
                    .evaluate(context)?
                    .as_array()
                    .cloned()
                    .ok_or_else(|| Error::Condition("append requires an array".into()))?;
                if items.len() >= 4096 {
                    return Err(Error::Condition("append exceeds 4096 items".into()));
                }
                items.push(value.evaluate(context)?);
                Value::Array(items)
            }
            Self::Contains { array, value } => {
                let array = array.evaluate(context)?;
                let items = array
                    .as_array()
                    .ok_or_else(|| Error::Condition("contains requires an array".into()))?;
                Value::Bool(items.contains(&value.evaluate(context)?))
            }
            Self::Not { value } => Value::Bool(!value.condition(context)?),
            Self::All { values } => {
                let mut result = true;
                for v in values {
                    if !v.condition(context)? {
                        result = false;
                        break;
                    }
                }
                Value::Bool(result)
            }
            Self::Any { values } => {
                let mut result = false;
                for v in values {
                    if v.condition(context)? {
                        result = true;
                        break;
                    }
                }
                Value::Bool(result)
            }
        })
    }
    pub fn condition(&self, context: &Value) -> Result<bool> {
        self.evaluate(context)?
            .as_bool()
            .ok_or_else(|| Error::Condition("condition must be boolean".into()))
    }
}

impl Expr {
    pub(crate) fn validate(&self, depth: usize, remaining: &mut usize) -> Result<()> {
        if depth > 32 || *remaining == 0 {
            return Err(Error::Definition(
                "expression size/depth limit exceeded".into(),
            ));
        }
        *remaining -= 1;
        match self {
            Self::Ref { path } | Self::Exists { path } => {
                if path.len() > 2048 || (!path.is_empty() && !path.starts_with('/')) {
                    return Err(Error::Definition(
                        "references must be bounded JSON Pointers".into(),
                    ));
                }
                let mut chars = path.chars();
                while let Some(c) = chars.next() {
                    if c == '~' && !matches!(chars.next(), Some('0' | '1')) {
                        return Err(Error::Definition("invalid JSON Pointer escape".into()));
                    }
                }
            }
            Self::Object { fields } => {
                for value in fields.values() {
                    value.validate(depth + 1, remaining)?;
                }
            }
            Self::Eq { left, right } | Self::Lt { left, right } | Self::Add { left, right } => {
                left.validate(depth + 1, remaining)?;
                right.validate(depth + 1, remaining)?;
            }
            Self::Append { array, value } | Self::Contains { array, value } => {
                array.validate(depth + 1, remaining)?;
                value.validate(depth + 1, remaining)?;
            }
            Self::Not { value } => value.validate(depth + 1, remaining)?,
            Self::All { values } | Self::Any { values } => {
                for value in values {
                    value.validate(depth + 1, remaining)?;
                }
            }
            Self::Literal { .. } => {}
        }
        Ok(())
    }
}
