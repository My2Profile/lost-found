using System.ComponentModel.DataAnnotations;
using LostAndFound.Api.Features.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Identity.Web.Resource;

namespace LostAndFound.Api.Features.Chat.Messages;

[ApiController]
[Route("api/conversations/{conversationId:guid}/messages")]
[Authorize]
[RequiredScope("access_as_user")]
public sealed class ConversationMessagesController(ChatMessageService messages) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Send(Guid conversationId, [FromBody] SendChatMessageRequest request, CancellationToken cancellationToken)
    {
        if(User.GetUserId() is not {} userId){
            return Unauthorized();
        }
        if(request.ClientMessageId == Guid.Empty)
        {
            ModelState.AddModelError(nameof(request.ClientMessageId), "Укажите ClientMessageId.");
        }

        if (string.IsNullOrWhiteSpace(request.Text))
        {
            ModelState.AddModelError(nameof(request.Text), "Введите сообщение.");
        }
        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        var conversation = await messages.FindAccessibleConversationAsync(conversationId, userId, cancellationToken);

        if(conversation is null)
        {
            return NotFound();
        }

        var result = await messages.SaveAsync(conversationId, userId, request.ClientMessageId, request.Text!, cancellationToken);

        if (result.Conflict)
        {
            return Conflict(new
            {
                message = "Этот ClientMessageId уже использован для другого текста"
            });
        }

        return StatusCode(
            result.Created
                ? StatusCodes.Status201Created
                : StatusCodes.Status200OK,
            ChatMessageResponse.From(result.Message));
    }

    [HttpGet]
    public async Task<IActionResult> History(Guid conversationId, [FromQuery] MessageHistoryRequest request, CancellationToken cancellationToken)
    {
        if (User.GetUserId() is not { } userId)
        {
            return Unauthorized();
        }

        var conversation =
            await messages.FindAccessibleConversationAsync(
                conversationId,
                userId,
                cancellationToken);

        if (conversation is null)
        {
            return NotFound();
        }

        var page = await messages.ReadHistoryAsync(
            conversationId,
            request.Before,
            request.Limit,
            cancellationToken);

        if (page is null)
        {
            return BadRequest(new
            {
                message = "Курсор before не относится к сообщениям этого диалога."
            });
        }

        return Ok(page);
    }
}

public sealed class SendChatMessageRequest
{
    public Guid ClientMessageId { get; init; }

    [Required]
    [StringLength(ChatMessageService.MaxTextLength)]
    public string? Text { get; init; }
}

public sealed class MessageHistoryRequest
{
    public Guid? Before { get; init; }

    [Range(1, 100)]
    public int Limit { get; init; } = 30;
}