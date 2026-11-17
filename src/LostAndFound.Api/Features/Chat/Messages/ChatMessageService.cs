using LostAndFound.Api.Infrastructure.Persistence;
using MongoDB.Driver;

namespace LostAndFound.Api.Features.Chat.Messages;

public sealed class ChatMessageService(ChatDbContext db, TimeProvider clock)
{
    public const int MaxTextLength = 4000;

    public Task<Conversation?> FindAccessibleConversationAsync(Guid conversationId, Guid userId, CancellationToken cancellationToken)
    {
        var filters = Builders<Conversation>.Filter;

        var filter = filters.Eq(x => x.Id,  conversationId) & (filters.Eq(x => x.OwnerUserId, userId) | filters.Eq(x => x.InitiatorUserId, userId));

        return db.Conversations.Find(filter).FirstOrDefaultAsync(cancellationToken);
    }

        public async Task<SendMessageResult> SaveAsync(
        Guid conversationId,
        Guid userId,
        Guid clientMessageId,
        string text,
        CancellationToken cancellationToken)
    {
        var body = text.Trim();

        if (clientMessageId == Guid.Empty ||
            body.Length is 0 or > MaxTextLength)
        {
            throw new ArgumentException(
                "Нужны непустой clientMessageId и текст длиной 1–4000 символов.");
        }

        var filters = Builders<ChatMessage>.Filter;

        var key =
            filters.Eq(x => x.ConversationId, conversationId) &
            filters.Eq(x => x.SenderUserId, userId) &
            filters.Eq(x => x.ClientMessageId, clientMessageId);

        var existing = await db.Messages
            .Find(key)
            .FirstOrDefaultAsync(cancellationToken);

        if (existing is not null)
        {
            return new SendMessageResult(
                existing,
                Created: false,
                Conflict: existing.Text != body);
        }

        var message = new ChatMessage
        {
            ConversationId = conversationId,
            SenderUserId = userId,
            ClientMessageId = clientMessageId,
            Text = body,

            // MongoDB хранит дату с точностью до миллисекунд.
            CreatedAt = DateTimeOffset
                .FromUnixTimeMilliseconds(
                    clock.GetUtcNow().ToUnixTimeMilliseconds())
                .UtcDateTime
        };

        try
        {
            await db.Messages.InsertOneAsync(
                message,
                cancellationToken: cancellationToken);

            return new SendMessageResult(
                message,
                Created: true,
                Conflict: false);
        }
        catch (MongoWriteException exception)
            when (exception.WriteError.Category ==
                  ServerErrorCategory.DuplicateKey)
        {
            // Параллельный запрос мог уже сохранить это сообщение.
            existing = await db.Messages
                .Find(key)
                .FirstOrDefaultAsync(cancellationToken);

            if (existing is null)
            {
                throw;
            }

            return new SendMessageResult(
                existing,
                Created: false,
                Conflict: existing.Text != body);
        }
    }

    public async Task<MessageHistoryResponse?> ReadHistoryAsync(
        Guid conversationId,
        Guid? before,
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }

        var filters = Builders<ChatMessage>.Filter;

        var filter = filters.Eq(
            x => x.ConversationId,
            conversationId);

        if (before is { } beforeId)
        {
            var cursor = await db.Messages
                .Find(
                    filter &
                    filters.Eq(x => x.Id, beforeId))
                .FirstOrDefaultAsync(cancellationToken);

            if (cursor is null)
            {
                return null;
            }

            var olderMessages =
                filters.Lt(x => x.CreatedAt, cursor.CreatedAt) |
                (
                    filters.Eq(x => x.CreatedAt, cursor.CreatedAt) &
                    filters.Lt(x => x.Id, cursor.Id)
                );

            filter &= olderMessages;
        }

        var messages = await db.Messages
            .Find(filter)
            .Sort(
                Builders<ChatMessage>.Sort
                    .Descending(x => x.CreatedAt)
                    .Descending(x => x.Id))
            .Limit(limit + 1)
            .ToListAsync(cancellationToken);

        var hasMore = messages.Count > limit;

        if (hasMore)
        {
            messages.RemoveAt(messages.Count - 1);
        }

        Guid? nextBefore = hasMore
            ? messages[^1].Id
            : null;

        return new MessageHistoryResponse(
            messages
                .Select(ChatMessageResponse.From)
                .ToArray(),
            nextBefore);
    }

}


public sealed record SendMessageResult(
    ChatMessage Message,
    bool Created,
    bool Conflict
);

public sealed record ChatMessageResponse(
    Guid Id, 
    Guid ConversationId,
    Guid SenderUserId,
    Guid ClientMessageId,
    string Text,
    DateTime CreatedAt
)
{
    public static ChatMessageResponse From(ChatMessage message)
    {
        return new ChatMessageResponse(
            message.Id,
            message.ConversationId,
            message.SenderUserId,
            message.ClientMessageId,
            message.Text,
            message.CreatedAt
        );
    }
}

public sealed record MessageHistoryResponse(
    IReadOnlyList<ChatMessageResponse> Items,
    Guid? NextBefore
);