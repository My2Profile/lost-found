using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;

namespace LostAndFound.Api.Features.Chat;

public sealed class ChatEvents
{
    private readonly ConcurrentDictionary<Guid, Subscription>
        subscriptions = new();

    public Subscription Subscribe(Guid conversationId)
    {
        var subscription = new Subscription(
            Guid.NewGuid(),
            conversationId);

        subscriptions[subscription.Id] = subscription;

        return subscription;
    }

    public void Remove(Subscription subscription)
    {
        subscriptions.TryRemove(subscription.Id, out _);

        subscription.Queue.Writer.TryComplete();
    }

    public void Publish(Guid conversationId, object payload)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(
            payload,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        foreach (var subscription in subscriptions.Values)
        {
            if (subscription.ConversationId != conversationId)
            {
                continue;
            }

            if (!subscription.Queue.Writer.TryWrite(bytes))
            {
                Remove(subscription);
            }
        }
    }

    public sealed class Subscription(
        Guid id,
        Guid conversationId)
    {
        public Guid Id { get; } = id;

        public Guid ConversationId { get; } = conversationId;

        public Channel<byte[]> Queue { get; } =
            Channel.CreateBounded<byte[]>(
                new BoundedChannelOptions(128)
                {
                    SingleReader = true,
                    FullMode = BoundedChannelFullMode.Wait
                });
    }
}