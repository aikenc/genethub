use std::time::Duration;

use futures_util::StreamExt;
use genet_daemon_logic_api::{
    CapabilityFailure, CapabilityFailureKind, CapabilityValue, HttpRequest, HttpResponse,
    RedirectPolicy, MAX_CAPABILITY_CHUNK_BYTES,
};

use crate::failure;

pub async fn execute(request: HttpRequest) -> Result<CapabilityValue, CapabilityFailure> {
    if request.body.len() > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "HTTP request body exceeds the capability chunk limit",
        ));
    }
    let response_limit = request.max_response_bytes as usize;
    if response_limit == 0 || response_limit > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "HTTP response limit is empty or exceeds the capability chunk limit",
        ));
    }
    if request.timeout_millis == 0 || request.timeout_millis > 300_000 {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            "HTTP timeout must be between 1 ms and 5 minutes",
        ));
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|error| {
        failure(
            CapabilityFailureKind::Invalid,
            format!("invalid HTTP method: {error}"),
        )
    })?;
    let url = reqwest::Url::parse(&request.url).map_err(|error| {
        failure(
            CapabilityFailureKind::Invalid,
            format!("invalid HTTP URL: {error}"),
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(failure(
            CapabilityFailureKind::Denied,
            "HTTP capability accepts only http and https URLs",
        ));
    }

    let redirect = match request.redirect {
        RedirectPolicy::None => reqwest::redirect::Policy::none(),
        RedirectPolicy::SameOrigin => {
            let expected_origin = origin(&url);
            reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() < 10 && origin(attempt.url()) == expected_origin {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            })
        }
        RedirectPolicy::HttpsOnly { max_hops } => {
            reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() < max_hops as usize && attempt.url().scheme() == "https"
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            })
        }
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(request.timeout_millis as u64))
        .redirect(redirect)
        .build()
        .map_err(http_failure)?;
    let mut builder = client.request(method, url).body(request.body);
    for (name, value) in request.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            failure(
                CapabilityFailureKind::Invalid,
                format!("invalid HTTP header name: {error}"),
            )
        })?;
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(|error| {
            failure(
                CapabilityFailureKind::Invalid,
                format!("invalid HTTP header value: {error}"),
            )
        })?;
        builder = builder.header(name, value);
    }
    let response = builder.send().await.map_err(http_failure)?;
    if response
        .content_length()
        .is_some_and(|length| length > response_limit as u64)
    {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "HTTP response exceeds its declared limit",
        ));
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(http_failure)?;
        if body.len().saturating_add(chunk.len()) > response_limit {
            return Err(failure(
                CapabilityFailureKind::TooLarge,
                "HTTP response exceeds its declared limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(CapabilityValue::Http(HttpResponse {
        status,
        headers,
        body,
    }))
}

fn origin(url: &reqwest::Url) -> (String, Option<String>, Option<u16>) {
    (
        url.scheme().to_string(),
        url.host_str().map(str::to_ascii_lowercase),
        url.port_or_known_default(),
    )
}

fn http_failure(error: reqwest::Error) -> CapabilityFailure {
    let kind = if error.is_timeout() || error.is_connect() {
        CapabilityFailureKind::Unavailable
    } else if error.is_builder() {
        CapabilityFailureKind::Invalid
    } else {
        CapabilityFailureKind::Internal
    };
    failure(kind, error.to_string())
}
