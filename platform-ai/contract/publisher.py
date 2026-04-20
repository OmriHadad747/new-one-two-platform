"""
Publishes messages to GCP Pub/Sub topics from the Python generator.

Topics:
  generation.progress  — ProgressEvent during processing
  generation.completed — FeatureBundleMessage on success or failure

Both SDKs honor PUBSUB_EMULATOR_HOST automatically in local dev.
"""
import json
from google.cloud import pubsub_v1

from config import get_settings
from contract.validators import ProgressEvent, FeatureBundleMessage

_publisher: pubsub_v1.PublisherClient | None = None


def _get_publisher() -> pubsub_v1.PublisherClient:
    global _publisher
    if _publisher is None:
        _publisher = pubsub_v1.PublisherClient()
    return _publisher


def _project() -> str:
    return get_settings().google_cloud_project


def publish_progress(event: ProgressEvent) -> None:
    """Publish a ProgressEvent to generation.progress."""
    publisher = _get_publisher()
    topic = f"projects/{_project()}/topics/generation.progress"
    data = json.dumps(event.model_dump(exclude_none=True)).encode("utf-8")
    future = publisher.publish(topic, data=data, jobId=event.jobId, agent=event.agent)
    future.result(timeout=10)


def publish_completed(bundle_msg: FeatureBundleMessage) -> None:
    """Publish a FeatureBundleMessage to generation.completed."""
    publisher = _get_publisher()
    topic = f"projects/{_project()}/topics/generation.completed"
    data = json.dumps(bundle_msg.to_dict()).encode("utf-8")
    future = publisher.publish(topic, data=data, jobId=bundle_msg.jobId, status=bundle_msg.status)
    future.result(timeout=10)
