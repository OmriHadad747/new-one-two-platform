"""
Subscribes to generation.requested and dispatches GenerationRequest to the callback.

The subscription name is "generator-sub" (created by pubsub-init in docker-compose).
PUBSUB_EMULATOR_HOST is honored automatically by the SDK in local dev.
"""

import json
import logging
from typing import Callable

from google.cloud import pubsub_v1

from config import get_settings
from contract.validators import GenerationRequest

log = logging.getLogger(__name__)

SUBSCRIPTION = "projects/{project}/subscriptions/generator-sub"


def subscribe_and_process(
    callback: Callable[[GenerationRequest], None],
    *,
    project: str | None = None,
) -> None:
    """
    Opens a streaming pull subscription and blocks forever.
    Call this in a daemon thread at app startup.

    Each message is ack'd on success, nack'd on parse/validation error.
    Application errors inside callback (generation failures) are caught,
    logged, and ack'd — the generator handles its own error reporting
    via publish_completed(status="failed").
    """
    project = project or get_settings().google_cloud_project
    sub_path = SUBSCRIPTION.format(project=project)

    subscriber = pubsub_v1.SubscriberClient()

    def on_message(message: pubsub_v1.types.PubsubMessage) -> None:
        try:
            raw = json.loads(message.data.decode("utf-8"))
            request = GenerationRequest.model_validate(raw)
        except Exception as exc:
            log.error("Failed to parse GenerationRequest: %s", exc)
            message.nack()
            return

        # Ack immediately after validation — generation can take 30-60 s and
        # the Pub/Sub ack deadline would expire before the callback returns,
        # causing duplicate deliveries.  Generation failures are reported via
        # publish_completed(status="failed"), so we don't need redelivery.
        message.ack()
        try:
            callback(request)
        except Exception as exc:
            log.error("Generation error for job %s: %s", request.jobId, exc)

    log.info("Subscribing to %s", sub_path)
    streaming_pull = subscriber.subscribe(sub_path, callback=on_message)
    try:
        streaming_pull.result()  # blocks until cancelled or error
    except Exception as exc:
        streaming_pull.cancel()
        log.error("Subscription closed: %s", exc)
