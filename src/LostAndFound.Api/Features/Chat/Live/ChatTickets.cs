using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace LostAndFound.Api.Features.Chat.Live;

public sealed class ChatTickets(TimeProvider clock)
{
    private readonly ConcurrentDictionary<string, Ticket> tickets = new();

    public string Issue(Guid conversationId, Guid userId)
    {
        var now = clock.GetUtcNow();

        foreach (var pair in tickets)
        {
            var expired = pair.Value.ExpiresAt <= now;

            var previous =
                pair.Value.UserId == userId &&
                pair.Value.ConversationId == conversationId;

            if (expired || previous)
            {
                tickets.TryRemove(pair.Key, out _);
            }
        }

        var key = Convert.ToHexString(
            RandomNumberGenerator.GetBytes(32));

        tickets[key] = new Ticket(
            conversationId,
            userId,
            now.AddSeconds(30));

        return key;
    }

    public Ticket? Consume(string key, Guid conversationId)
    {
        if (!tickets.TryRemove(key, out var ticket))
        {
            return null;
        }

        if (ticket.ConversationId != conversationId ||
            ticket.ExpiresAt <= clock.GetUtcNow())
        {
            return null;
        }

        return ticket;
    }

    public sealed record Ticket(
        Guid ConversationId,
        Guid UserId,
        DateTimeOffset ExpiresAt);
}